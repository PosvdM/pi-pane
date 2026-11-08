import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { writeFile, utimes, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { probeSessionWriterLock, isSameProcess } from "pi-hostkit";
import { RequestLedger } from "../packages/server/dist/control.js";
import { fileKey } from "../packages/server/dist/store.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
const commands = fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function holdReadyStart(driver, gate) {
  const start = driver.start.bind(driver); const entered = deferred(); entered.promise.catch(() => {});
  driver.start = async (...args) => {
    try { const handle = await start(...args); await handle.ready; entered.resolve(handle); await gate.promise; return handle; }
    catch (error) { entered.reject(error); throw error; }
  };
  return entered.promise;
}
async function setup(afterListen = async () => {}) {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const target = f.sessionPath("stop-race-target"); let server;
  try {
    await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "stop-race-target", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
    await utimes(target, new Date(0), new Date(0));
    server = await startServer(f, { extraExtensions: [providerPath, commands] });
    await afterListen({ server, f, target });
    const token = await pair(server); const b = await open(server, token, f, { sessionFile: target });
    const first = await control(server, token, await open(server, token, f), { type: "prompt", message: "源会话" });
    assert.equal(first.code, 200, JSON.stringify({ response: first, serverStopping: server.stopping, serverCloseStarted: !!server.closePromise,
      inflightClosing: server.sessions.inflight.closing, sessionsCloseStarted: !!server.sessions.closePromise }));
    const a = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s; });
    server.sessions.ledger = new RequestLedger(Date.now, 50);
    return { f, target, server, token, a, b };
  } catch (error) {
    // 调用方尚未进入 try/finally；初始化失败仍须关闭已经监听或启动写者的现场。
    const failures = [error];
    try { await server?.close(); } catch (failure) { failures.push(failure); }
    try { await f.cleanup(); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "切换测试初始化或清理失败");
    throw error;
  }
}
async function final(server, token, route, body) {
  return until(async () => { const r = await request(server, token, route, body); return r.value.status !== "pending" && r; });
}

test("切换测试初始化拒绝时关闭真实写者、HTTP 和实例锁并清理现场", { timeout: 30000 }, async () => {
  const failure = new Error("注入初始化拒绝"); let server; let handle; let root; let released = false;
  await assert.rejects(setup(async value => {
    server = value.server; root = value.f.root;
    const view = await server.sessions.open({ cwd: value.f.cwd });
    const source = server.sessions.records.get(view.ref.id); await server.sessions.start(source); handle = source.handle;
    const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    throw failure;
  }), error => error === failure);
  assert.equal(server.http.listening, false); assert.equal(released, true);
  assert.equal(await isSameProcess(handle.identity), "gone"); assert.equal(server.sessions.handles.size, 0);
  if (!process.env.KEEP_FIXTURES) await assert.rejects(stat(root), { code: "ENOENT" });
});

test("迟到启动的就绪拒绝会传给入口 gate，不留下永远等待的 entered", async () => {
  const failure = new Error("注入就绪前启动失败"); const gate = deferred();
  const driver = { start: async () => ({ ready: Promise.reject(failure) }) };
  const entered = holdReadyStart(driver, gate); const starting = driver.start();
  await assert.rejects(entered, error => error === failure);
  await assert.rejects(starting, error => error === failure); gate.resolve();
});

test("A resume 已打开的 B 后扩展永久等待，控制队列随写者迁移，B.stop 仍能抢占", { timeout: 30000 }, async () => {
  const { f, target, server, token, a, b } = await setup();
  try {
    const source = server.sessions.records.get(a.ref.id); const targetRecord = server.sessions.records.get(b.ref.id);
    const queue = source.control; const handle = source.handle;
    const route = "/api/sessions/" + a.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: a.cursor.epoch, expectedRevision: a.controlRevision, command: { type: "prompt", message: "/pane-test-resume-hang " + target } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
    const rebound = await until(async () => { const s = await snapshot(server, token, b.ref.id); return !s.readonly && s; });
    assert.equal(targetRecord.control, queue); assert.notEqual(source.control, queue);
    assert.equal(targetRecord.control.busy, true); assert.equal(targetRecord.handle, handle);
    const bRoute = "/api/sessions/" + b.ref.id + "/control";
    const queued = { requestId: randomUUID(), expectedEpoch: rebound.cursor.epoch, expectedRevision: rebound.controlRevision, command: { type: "set_session_name", name: "不得绕过活动操作" } };
    assert.deepEqual((await request(server, token, bRoute, queued)).value, { status: "pending" });
    const stop = { requestId: randomUUID(), expectedEpoch: rebound.cursor.epoch, expectedRevision: rebound.controlRevision, command: { type: "stop" } };
    const stopped = await final(server, token, bRoute, stop); assert.equal(stopped.code, 200, JSON.stringify(stopped)); assert.ok(stopped.value.stopReport);
    assert.equal(await isSameProcess(handle.identity), "gone"); assert.equal((await probeSessionWriterLock(target)).held, false);
    const original = await final(server, token, route, body); assert.equal(original.value.error, "rpcResultUnknown");
    assert.equal((await final(server, token, bRoute, queued)).value.error, "controlPreempted");
    assert.equal((await snapshot(server, token, b.ref.id)).readonly, true);
  } finally { await server.close(); await f.cleanup(); }
});

for (const restart of [false, true]) test(`切换持久化迟到于停止${restart ? "并重新启动 A" : ""}，不重绑定 B 或重建旧运行记录`, { timeout: 30000 }, async () => {
  const { f, target, server, token, a, b } = await setup(); const gate = deferred();
  let handle;
  try {
    const source = server.sessions.records.get(a.ref.id); const destination = server.sessions.records.get(b.ref.id);
    handle = source.handle; const entered = deferred(); const persist = handle.persist.bind(handle);
    handle.persist = async () => { entered.resolve(); await gate.promise; await persist(); };
    const route = "/api/sessions/" + a.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: a.cursor.epoch, expectedRevision: a.controlRevision, command: { type: "prompt", message: "/pane-test-resume-hang " + target } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
    await entered.promise;
    const current = await snapshot(server, token, a.ref.id);
    const stopped = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: current.cursor.epoch, expectedRevision: current.controlRevision, command: { type: "stop" } });
    assert.equal(stopped.code, 200, JSON.stringify(stopped)); await handle.exited;
    assert.equal(await isSameProcess(handle.identity), "gone"); assert.equal(source.handle, undefined);
    await assert.rejects(stat(handle.recordFile), { code: "ENOENT" });
    let replacement;
    if (restart) {
      const fresh = await snapshot(server, token, a.ref.id);
      const started = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: fresh.cursor.epoch, expectedRevision: fresh.controlRevision, command: { type: "prompt", message: "重新启动源会话" } });
      assert.equal(started.code, 200, JSON.stringify(started)); replacement = source.handle;
      assert.ok(replacement); assert.notEqual(replacement, handle); assert.equal(replacement.acceptingInput, true);
    }
    gate.resolve(); await handle.initialization;
    if (restart) assert.equal(source.handle, replacement, "旧回调不能把 A 的新 handle 迁到 B");
    await assert.rejects(stat(handle.recordFile), { code: "ENOENT" });
    assert.equal(destination.handle, undefined); assert.equal(destination.model.readonly, true);
    assert.equal((await snapshot(server, token, b.ref.id)).readonly, true);
    assert.equal(handle.acceptingInput, false);
  } finally { gate.resolve(); if (handle) await handle.initialization; await server.close(); await f.cleanup(); }
});

test("停止清理等待已进入的持久化写入，迟到写入与临时文件均被清理", { timeout: 30000 }, async () => {
  const { f, server, a } = await setup(); const gate = deferred(); let writing;
  try {
    const handle = server.sessions.records.get(a.ref.id).handle; const entered = deferred();
    const write = handle.writeRecord.bind(handle);
    handle.writeRecord = async () => { entered.resolve(); await gate.promise; await write(); };
    writing = handle.persist(); await entered.promise;
    let finished = false; const stopping = handle.stop().then(() => { finished = true; });
    await until(async () => handle.locks.size === 0);
    assert.equal(await isSameProcess(handle.identity), "gone");
    assert.equal(finished, false, "写入已进入持久化队列，停止不能先于迟到 rename 完成");
    gate.resolve(); await writing; await stopping; await handle.exited;
    await assert.rejects(stat(handle.recordFile), { code: "ENOENT" });
    await assert.rejects(stat(handle.recordFile + ".tmp"), { code: "ENOENT" });
  } finally { gate.resolve(); await writing; await server.close(); await f.cleanup(); }
});

test("旧写锁释放迟到于停止，不提交 current 或重绑定", { timeout: 30000 }, async () => {
  const { f, target, server, token, a, b } = await setup(); const gate = deferred(); let handle;
  try {
    handle = server.sessions.records.get(a.ref.id).handle; const entered = deferred();
    const old = handle.current; const release = old.release.bind(old);
    old.release = async options => { if (options?.writerSwitchedAway) { entered.resolve(); await gate.promise; } return release(options); };
    const route = "/api/sessions/" + a.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: a.cursor.epoch, expectedRevision: a.controlRevision, command: { type: "prompt", message: "/pane-test-resume-hang " + target } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" }); await entered.promise;
    await handle.stop(); await handle.exited;
    gate.resolve(); await handle.initialization;
    assert.equal(handle.current, old); assert.equal(handle.acceptingInput, false);
    assert.equal((await snapshot(server, token, b.ref.id)).readonly, true);
    await assert.rejects(stat(handle.recordFile), { code: "ENOENT" });
  } finally { gate.resolve(); if (handle) await handle.initialization; await server.close(); await f.cleanup(); }
});

test("持久化等待期间代次变化，只有最新 bridgeReady 可以提交重绑定", { timeout: 30000 }, async () => {
  const { f, target, server, token, a, b } = await setup(); const gate = deferred(); let handle;
  try {
    handle = server.sessions.records.get(a.ref.id).handle; const entered = deferred();
    const persist = handle.persist.bind(handle); let first = true; const reasons = [];
    handle.persist = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } await persist(); };
    const onReady = handle.callbacks.onReady;
    handle.callbacks.onReady = (...args) => { reasons.push(args[2]); onReady(...args); };
    const body = { requestId: randomUUID(), expectedEpoch: a.cursor.epoch, expectedRevision: a.controlRevision, command: { type: "prompt", message: "/pane-test-resume-hang " + target } };
    assert.deepEqual((await request(server, token, "/api/sessions/" + a.ref.id + "/control", body)).value, { status: "pending" });
    await entered.promise;
    await handle.bridgeEvent({ type: "shutdown", reason: "reload" });
    await handle.bridgeEvent({ type: "bridgeReady", sessionFile: target, sessionId: b.ref.id, cwd: f.cwd, trusted: false, reason: "reload" });
    await new Promise(setImmediate); gate.resolve(); await handle.initialization;
    assert.deepEqual(reasons, ["reload"]); assert.equal(handle.acceptingInput, true);
    assert.equal(server.sessions.records.get(b.ref.id).handle, handle);
  } finally { gate.resolve(); if (handle) await handle.initialization; await server.close(); await f.cleanup(); }
});

test("旧 handle 的 ready、事件和退出回调均不能修改重新启动的会话", { timeout: 30000 }, async () => {
  const { f, target, server, token, a, b } = await setup();
  try {
    const source = server.sessions.records.get(a.ref.id); const old = source.handle;
    await old.stop(); await old.exited;
    const fresh = await snapshot(server, token, a.ref.id); const route = "/api/sessions/" + a.ref.id + "/control";
    const result = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: fresh.cursor.epoch, expectedRevision: fresh.controlRevision, command: { type: "prompt", message: "新写者" } });
    assert.equal(result.code, 200, JSON.stringify(result));
    await until(() => source.model.status === "idle"); const replacement = source.handle;
    const before = source.model.snapshot(); const reports = server.sessions.reports.length;
    old.callbacks.onReady({ sessionFile: target, sessionId: b.ref.id, cwd: f.cwd }, { entries: [] }, "resume", old);
    old.callbacks.onRecord({ type: "agent_start" });
    old.callbacks.onRecord({ type: "extension_ui_request", id: "stale-ui", method: "input" });
    old.callbacks.onExit("会话已关闭", { steps: [], leftovers: [] });
    assert.equal(source.handle, replacement); assert.equal(replacement.acceptingInput, true);
    assert.deepEqual(source.model.snapshot(), before); assert.equal(source.ui.size, 0);
    assert.equal(server.sessions.reports.length, reports);
    assert.equal(server.sessions.records.get(b.ref.id).handle, undefined);
    assert.equal((await snapshot(server, token, b.ref.id)).readonly, true);
  } finally { await server.close(); await f.cleanup(); }
});

test("控制响应后的状态查询迟到于停止，不提交旧 handle 的状态", { timeout: 30000 }, async () => {
  const { f, server, token, a } = await setup(); const gate = deferred();
  try {
    const source = server.sessions.records.get(a.ref.id); const handle = source.handle; const state = source.state;
    const send = handle.send.bind(handle); const entered = deferred(); let armed = false;
    handle.send = async (command, options) => {
      const response = await send(command, options);
      if (command.type === "set_thinking_level") armed = true;
      if (command.type === "get_state" && armed) { armed = false; entered.resolve(); await gate.promise; }
      return response;
    };
    const route = "/api/sessions/" + a.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: a.cursor.epoch, expectedRevision: a.controlRevision, command: { type: "set_thinking_level", level: "high" } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" }); await entered.promise;
    const current = await snapshot(server, token, a.ref.id);
    const stopped = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: current.cursor.epoch, expectedRevision: current.controlRevision, command: { type: "close" } });
    assert.equal(stopped.code, 200, JSON.stringify(stopped)); await handle.exited;
    gate.resolve(); const confirmed = await final(server, token, route, body);
    assert.equal(confirmed.code, 200, JSON.stringify(confirmed)); assert.equal(confirmed.value.response.success, true);
    assert.equal(source.state, state, "已停止写者的迟到 get_state 不能提交到会话");
    assert.equal(source.model.readonly, true);
  } finally { gate.resolve(); await server.close(); await f.cleanup(); }
});

test("就绪回调先于 start 返回时，停止仍能找到来源 handle 且迟到返回不重新挂载", { timeout: 30000 }, async () => {
  const { f, server, token, a } = await setup(); const gate = deferred();
  try {
    const source = server.sessions.records.get(a.ref.id); await source.handle.stop();
    const entered = holdReadyStart(server.sessions.driver, gate);
    const fresh = await snapshot(server, token, a.ref.id); const route = "/api/sessions/" + a.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: fresh.cursor.epoch, expectedRevision: fresh.controlRevision, command: { type: "prompt", message: "不得迟到发送" } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
    const handle = await entered; assert.equal(source.handle, handle);
    const current = await snapshot(server, token, a.ref.id);
    const stopped = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: current.cursor.epoch, expectedRevision: current.controlRevision, command: { type: "stop" } });
    assert.equal(stopped.code, 200, JSON.stringify(stopped)); await handle.exited;
    assert.equal(await isSameProcess(handle.identity), "gone"); gate.resolve();
    assert.equal((await final(server, token, route, body)).value.error, "interrupted");
    assert.equal(source.handle, undefined); assert.equal(source.model.readonly, true);
    await assert.rejects(stat(handle.recordFile), { code: "ENOENT" });
  } finally { gate.resolve(); await server.close(); await f.cleanup(); }
});

test("启动故障及退出先于 start 返回时，保留原始 bridgeFailed 结果", { timeout: 30000 }, async () => {
  const { f, server, token, a } = await setup();
  try {
    const source = server.sessions.records.get(a.ref.id); await source.handle.stop();
    const start = server.sessions.driver.start.bind(server.sessions.driver);
    server.sessions.driver.start = async (...args) => {
      const handle = await start(...args); handle.fail("测试启动返回前故障"); await handle.exited; return handle;
    };
    const fresh = await snapshot(server, token, a.ref.id); const route = "/api/sessions/" + a.ref.id + "/control";
    const result = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: fresh.cursor.epoch, expectedRevision: fresh.controlRevision, command: { type: "prompt", message: "不得发送" } });
    assert.equal(result.code, 503, JSON.stringify(result)); assert.equal(result.value.error, "bridgeFailed");
    assert.equal(source.handle, undefined); assert.equal(source.model.status, "interrupted");
  } finally { await server.close(); await f.cleanup(); }
});

test("旧 shutdown 的目标取锁失败迟到于新代次，不污染新初始化", { timeout: 30000 }, async () => {
  const { f, target, server, a } = await setup(); const gate = deferred();
  try {
    const handle = server.sessions.records.get(a.ref.id).handle; const entered = deferred();
    handle.target = async () => { entered.resolve(); await gate.promise; throw new Error("旧代次目标取锁失败"); };
    const obsolete = handle.bridgeEvent({ type: "shutdown", reason: "resume", target }); await entered.promise;
    await handle.bridgeEvent({ type: "shutdown", reason: "reload" });
    gate.resolve(); await obsolete; assert.equal(handle.switchFailure, undefined);
    await handle.bridgeEvent({ type: "bridgeReady", sessionFile: a.sessionFile, sessionId: a.ref.id, cwd: f.cwd, trusted: false, reason: "reload" });
    await new Promise(setImmediate); await handle.initialization;
    assert.equal(handle.acceptingInput, true); assert.equal(server.sessions.records.get(a.ref.id).handle, handle);
  } finally { gate.resolve(); await server.close(); await f.cleanup(); }
});

test("只读文件读取迟到于启动、切换和停止，不把旧文件提交到新模型", { timeout: 30000 }, async (t) => {
  const { f, server, token, a } = await setup(); const gate = deferred(); const returned = deferred(); let injected = false;
  try {
    const source = server.sessions.records.get(a.ref.id); const old = source.handle;
    await old.stop(); await old.exited;
    const target = f.sessionPath("late-watch-target");
    await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "late-watch-target", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
    const read = fs.readFile; const entered = deferred();
    const mock = t.mock.method(fs, "readFile", async (...args) => {
      const data = await read(...args);
      if (typeof args[0] === "string" && fileKey(args[0]) === fileKey(a.sessionFile)) {
        // 所有同路径 watch 读取都停在窗口内，后续读取不能先 reset 模型、推进 epoch。
        if (!injected) { injected = true; entered.resolve(); }
        await gate.promise; returned.resolve();
      }
      return data;
    });
    syncBuiltinESMExports();
    await utimes(a.sessionFile, new Date(), new Date()); await entered.promise;
    const fresh = await snapshot(server, token, a.ref.id); const route = "/api/sessions/" + a.ref.id + "/control";
    const started = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: fresh.cursor.epoch, expectedRevision: fresh.controlRevision, command: { type: "prompt", message: "/pane-test-resume " + target } });
    assert.equal(started.code, 200, JSON.stringify(started));
    const rebound = await until(() => source.id === "late-watch-target" && source.handle?.acceptingInput);
    assert.equal(rebound, true); await source.handle.stop();
    const before = source.model.snapshot();
    gate.resolve(); await returned.promise; await new Promise(setImmediate);
    assert.deepEqual(source.model.snapshot(), before, "读到的 A 不能重置已切到新文件且停止的模型");
    mock.mock.restore(); syncBuiltinESMExports();
  } finally { gate.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); await server.close(); await f.cleanup(); }
});

for (const close of [false, true]) test(`只读打开的 stat 迟到于${close ? "服务关闭，不登记新会话" : "同路径另一请求启动，不覆盖托管记录"}`, { timeout: 30000 }, async (t) => {
  const { f, server, token } = await setup(); const gate = deferred(); let opening; let hosted;
  try {
    const file = f.sessionPath("late-open");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "late-open", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
    await utimes(file, new Date(0), new Date(0));
    const readStat = fs.stat; const entered = deferred(); let injected = false;
    t.mock.method(fs, "stat", async (...args) => {
      const value = await readStat(...args);
      if (!injected && typeof args[0] === "string" && fileKey(args[0]) === fileKey(file)) { injected = true; entered.resolve(); await gate.promise; }
      return value;
    });
    syncBuiltinESMExports(); opening = server.sessions.open({ cwd: f.cwd, sessionFile: file }); await entered.promise;
    if (close) {
      let finished = false; const closing = server.sessions.close().then(() => { finished = true; });
      await new Promise(setImmediate); assert.equal(finished, false, "关闭屏障包含在途 open 的后续读取"); gate.resolve();
      await assert.rejects(opening, { code: "serverStopping" }); await closing;
      assert.equal(server.sessions.records.has("late-open"), false);
    } else {
      const other = await open(server, token, f, { sessionFile: file });
      const route = "/api/sessions/late-open/control";
      const started = await final(server, token, route, { requestId: randomUUID(), expectedEpoch: other.cursor.epoch, expectedRevision: other.controlRevision, command: { type: "prompt", message: "保留已登记的托管写者" } });
      assert.equal(started.code, 200, JSON.stringify(started)); hosted = server.sessions.records.get("late-open"); const handle = hosted.handle;
      assert.ok(handle?.acceptingInput); gate.resolve(); const late = await opening;
      assert.ok(server.sessions.records.get("late-open") === hosted, "迟到 open 不得覆盖已托管记录");
      assert.equal(server.sessions.files.get(fileKey(file)).handle, handle); assert.equal(late.readonly, false);
    }
  } finally {
    gate.resolve(); await opening?.catch(() => {}); t.mock.restoreAll(); syncBuiltinESMExports();
    if (hosted?.handle) await hosted.handle.stop(); await server.close(); await f.cleanup();
  }
});

test("服务关闭正在等待较早记录时，后续写者不能重绑定到已关闭目标而漏停", { timeout: 30000 }, async () => {
  const { f, target, server, token, a, b } = await setup(); const gate = deferred(); let closing; let handle;
  try {
    const initialB = await snapshot(server, token, b.ref.id);
    const hostedB = await final(server, token, "/api/sessions/" + b.ref.id + "/control", { requestId: randomUUID(), expectedEpoch: initialB.cursor.epoch, expectedRevision: initialB.controlRevision, command: { type: "prompt", message: "先托管目标" } });
    assert.equal(hostedB.code, 200, JSON.stringify(hostedB));
    const destination = server.sessions.records.get(b.ref.id); const first = destination.handle;
    const stop = first.stop.bind(first); const entered = deferred();
    first.stop = async () => { const report = await stop(); entered.resolve(); await gate.promise; return report; };
    const source = server.sessions.records.get(a.ref.id); handle = source.handle;
    const sourceStop = handle.proc.stop.bind(handle.proc);
    handle.proc.stop = async (...args) => { await gate.promise; return sourceStop(...args); };
    closing = server.sessions.close(); await entered.promise;
    assert.equal(destination.closed, true); assert.equal(destination.handle, undefined); assert.equal(source.closed, true);
    await assert.rejects(handle.send({ type: "prompt", message: "/pane-test-resume " + target }), { code: "serverStopping" });
    // 已受理操作的迟到回调仍不能绕过会话关闭检查，直接覆盖回调归属边界。
    handle.callbacks.onReady({ sessionFile: target, sessionId: b.ref.id, cwd: f.cwd }, { entries: [] }, "resume", handle);
    assert.ok(destination.handle === undefined, "关闭遍历已经经过的目标不能接收迟到写者");
    assert.equal(source.handle, handle);
    gate.resolve(); await closing; await handle.exited;
    assert.equal(await isSameProcess(handle.identity), "gone");
  } finally { gate.resolve(); await closing; if (handle) await handle.stop(); await server.close(); await f.cleanup(); }
});

test("停止完成后目标取锁才返回，不登记运行写者并释放迟到锁", { timeout: 30000 }, async () => {
  const { f, target, server, token, a } = await setup(); const gate = deferred();
  try {
    const handle = server.sessions.records.get(a.ref.id).handle; const acquired = deferred();
    const acquire = handle.acquireWriter;
    handle.acquireWriter = async (...args) => {
      const lock = await acquire(...args);
      if (fileKey(args[0]) === fileKey(target)) { acquired.resolve(); await gate.promise; }
      return lock;
    };
    const route = "/api/sessions/" + a.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: a.cursor.epoch, expectedRevision: a.controlRevision, command: { type: "prompt", message: "/pane-test-resume " + target } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
    await acquired.promise; assert.equal((await probeSessionWriterLock(target)).held, true);
    const current = await snapshot(server, token, a.ref.id);
    const stop = { requestId: randomUUID(), expectedEpoch: current.cursor.epoch, expectedRevision: current.controlRevision, command: { type: "stop" } };
    const stopped = await final(server, token, route, stop); assert.equal(stopped.code, 200, JSON.stringify(stopped));
    await handle.exited; assert.equal(await isSameProcess(handle.identity), "gone");
    assert.equal((await probeSessionWriterLock(target)).held, true, "延迟返回的真实内核锁尚未交给 driver");
    gate.resolve();
    await until(async () => !(await probeSessionWriterLock(target)).held);
    const released = await probeSessionWriterLock(target); assert.equal(released.record.state, "released"); assert.equal(released.record.writer, undefined);
    assert.equal(handle.locks.size, 0); assert.equal((await probeSessionWriterLock(a.sessionFile)).held, false);
    assert.equal((await final(server, token, route, body)).value.error, "rpcResultUnknown");
  } finally { gate.resolve(); await server.close(); await f.cleanup(); }
});
