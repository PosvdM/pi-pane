import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, writeFile, utimes } from "node:fs/promises";
import { isSameProcess, probeSessionWriterLock } from "pi-hostkit";
import { Sessions } from "../packages/server/dist/sessions.js";
import { AssetStore } from "../packages/server/dist/assets.js";
import { SessionModel } from "../packages/server/dist/model.js";
import { ControlQueue } from "../packages/server/dist/control.js";
import { fileKey } from "../packages/server/dist/store.js";
import { piFixture } from "./fixtures/helpers.mjs";
import { startServer } from "./fixtures/client.mjs";
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

for (const phase of ["acquire", "spawn"]) test(`关闭等待 start 返回及 ready 之前的 ${phase}，实例锁最后释放`, { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred();
  let starting; let closing; let proc; let spawned = 0;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    const acquire = server.sessions.driver.acquireWriter;
    server.sessions.driver.acquireWriter = async (...args) => {
      const lock = await acquire(...args); const spawn = lock.spawnWriter.bind(lock);
      lock.spawnWriter = async (...args) => { spawned++; proc = await spawn(...args); if (phase === "spawn") { entered.resolve(); await gate.promise; } return proc; };
      if (phase === "acquire") { entered.resolve(); await gate.promise; }
      return lock;
    };
    starting = server.sessions.start(source).catch(error => error); await entered.promise;
    assert.equal(source.handle, undefined); assert.equal((await probeSessionWriterLock(source.file)).held, true);
    let sessionsFinished = false; const closeSessions = server.sessions.close.bind(server.sessions);
    server.sessions.close = () => closeSessions().then(() => { sessionsFinished = true; });
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    closing = server.close(); const concurrentClose = server.close(); let concurrentFinished = false;
    concurrentClose.then(() => { concurrentFinished = true; });
    await new Promise(setImmediate);
    assert.equal(sessionsFinished, false, "无 handle 的在途启动清理前，Sessions.close 不能报告成功");
    assert.equal(concurrentFinished, false, "并发 close 必须等待同一关闭流程");
    assert.equal(released, false); assert.equal(server.http.listening, true);
    gate.resolve(); const result = await starting; await closing; await concurrentClose;
    assert.equal(result.code, "interrupted"); assert.equal(released, true);
    assert.equal(spawned, phase === "acquire" ? 0 : 1, "取消后的迟到取锁不能继续 spawn");
    if (proc) assert.equal(await isSameProcess(proc.identity), "gone");
    assert.equal((await probeSessionWriterLock(source.file)).held, false);
    assert.deepEqual(await readdir(path.join(f.root, "pane", "run")), []);
  } finally { gate.resolve(); await starting; await closing; await server.close(); await f.cleanup(); }
});

for (const phase of ["trust", "directory", "restart"]) test(`关闭登记并等待 ${phase} 阶段的启动`, { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred();
  let starting; let closing;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    const object = phase === "directory" ? server.sessions.store : server.sessions.trust;
    const key = phase === "directory" ? "sessionDir" : "request"; const original = object[key].bind(object);
    object[key] = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
    if (phase === "restart") {
      source.model.interrupt("test", "测试重启"); const snapshot = server.sessions.snapshot(source.id);
      starting = server.sessions.command(source.id, { requestId: randomUUID(), expectedEpoch: snapshot.cursor.epoch, expectedRevision: snapshot.controlRevision, command: { type: "restart" } }).catch(error => error);
    } else starting = server.sessions.start(source).catch(error => error);
    await entered.promise; let finished = false;
    closing = server.close().then(() => { finished = true; }); await new Promise(setImmediate);
    assert.equal(finished, false, "进入 driver 前的异步工作也必须包含在关闭等待中");
    gate.resolve(); assert.equal((await starting).code, "interrupted"); await closing;
    assert.equal((await probeSessionWriterLock(source.file)).held, false);
    assert.deepEqual(await readdir(path.join(f.root, "pane", "run")), []);
  } finally { gate.resolve(); await starting; await closing; await server.close(); await f.cleanup(); }
});

for (const reason of ["resume", "reload", "exited-resume"]) test(`关闭排空 ${reason} 的迟到目标写锁与初始化`, { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred();
  let switching; let closing;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    await server.sessions.start(source); const handle = source.handle;
    const target = f.sessionPath("late-target");
    await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "late-target", cwd: f.cwd }) + "\n");
    await utimes(target, new Date(0), new Date(0));
    const acquire = handle.acquireWriter;
    handle.acquireWriter = async (...args) => { const lock = await acquire(...args); if (fileKey(args[0]) === fileKey(target)) { entered.resolve(); await gate.promise; } return lock; };
    switching = handle.bridgeEvent({ type: "shutdown", reason: "resume", target }); await entered.promise;
    if (reason === "reload") await handle.bridgeEvent({ type: "shutdown", reason: "reload" });
    if (reason === "exited-resume") { await handle.stop(); assert.equal(source.handle, undefined); }
    let finished = false; closing = server.close().then(() => { finished = true; });
    await handle.exited; await new Promise(setImmediate);
    assert.equal(finished, false, "退出回调摘下 handle 后，关闭仍须等待在途目标锁");
    assert.equal((await probeSessionWriterLock(target)).held, true);
    gate.resolve(); await switching; await closing;
    assert.equal(await isSameProcess(handle.identity), "gone");
    assert.equal((await probeSessionWriterLock(target)).held, false);
    assert.equal((await probeSessionWriterLock(source.file)).held, false);
    assert.deepEqual(await readdir(path.join(f.root, "pane", "run")), []);
  } finally { gate.resolve(); await switching; await closing; await server.close(); await f.cleanup(); }
});

test("关闭等待 reload 的在途初始化排空，不允许迟到 ready 恢复输入", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred(); let closing; let handle;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    await server.sessions.start(source); handle = source.handle; const raw = handle.raw.bind(handle);
    handle.raw = async (...args) => { const response = await raw(...args); if (args[0].type === "get_entries") { entered.resolve(); await gate.promise; } return response; };
    await handle.bridgeEvent({ type: "shutdown", reason: "reload" });
    await handle.bridgeEvent({ type: "bridgeReady", sessionFile: source.file, sessionId: source.id, cwd: f.cwd, trusted: false, reason: "reload" });
    await entered.promise; let finished = false; closing = server.close().then(() => { finished = true; });
    await handle.exited; await new Promise(setImmediate); assert.equal(finished, false);
    gate.resolve(); await closing; await handle.initialization;
    assert.equal(handle.acceptingInput, false); assert.equal(source.handle, undefined);
    assert.equal(await isSameProcess(handle.identity), "gone");
    assert.equal((await probeSessionWriterLock(source.file)).held, false);
    assert.deepEqual(await readdir(path.join(f.root, "pane", "run")), []);
  } finally { gate.resolve(); await closing; if (handle) await handle.initialization; await server.close(); await f.cleanup(); }
});

test("停止未确认时关闭返回失败并保留实例锁，并发调用不报告成功", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); let stop; let handle;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    await server.sessions.start(source); handle = source.handle; stop = handle.stop.bind(handle);
    handle.stop = async () => { throw new Error("注入停止未确认"); };
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    await assert.rejects(server.close(), AggregateError); await assert.rejects(server.close(), AggregateError);
    assert.equal(released, false); assert.equal((await probeSessionWriterLock(source.file)).held, true);
  } finally { if (stop) { handle.stop = stop; await stop(); } await server.lock.release(); await f.cleanup(); }
});

test("重绑定复制出的旧记录不继承 syncing，重新托管后真正取条目", async () => {
  const sessions = Object.create(Sessions.prototype); sessions.assets = new AssetStore("unused");
  sessions.records = new Map(); sessions.files = new Map(); sessions.watch = () => {};
  const gate = deferred(); const file = path.resolve("sync-source.jsonl"); const destination = path.resolve("sync-target.jsonl");
  const handle = { acceptingInput: true, send: async () => { await gate.promise; return { data: { entries: [] } }; } };
  const source = { id: "source", file, cwd: process.cwd(), model: new SessionModel({ source: "pane", id: "source" }, sessions.assets),
    handle, control: new ControlQueue(), owner: Symbol(), dirty: false, drafts: new Map(), clients: 0, lastActive: 0, holds: new Map(), ui: new Map(), recentExternal: false, closed: false };
  sessions.records.set(source.id, source); sessions.files.set(fileKey(file), source);
  const syncing = sessions.sync(source); source.dirty = true;
  sessions.rebind(source, handle, { sessionId: "target", sessionFile: destination }, { entries: [] }, "resume");
  const previous = sessions.records.get("source"); gate.resolve(); await syncing;
  let reads = 0; previous.handle = { acceptingInput: true, send: async () => { reads++; return { data: { entries: [] } }; } };
  await sessions.sync(previous); assert.equal(reads, 1, "旧记录重新启动后必须执行 get_entries，不能复用已完成的 Promise");
  assert.equal(previous.syncing, undefined); assert.equal(previous.dirty, false);
});
