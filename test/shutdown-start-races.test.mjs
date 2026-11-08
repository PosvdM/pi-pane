import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs, { readdir, writeFile, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { inspect } from "node:util";
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

test("创建 handle 后立即交付，首次 persist 和 start 返回前可以停止写者", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred(); let starting; let closing;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    const start = server.sessions.driver.start.bind(server.sessions.driver);
    server.sessions.driver.start = (spec, callbacks, signal) => start(spec, { ...callbacks, onHandle: handle => {
      callbacks.onHandle(handle); const persist = handle.persist.bind(handle);
      handle.persist = async () => { entered.resolve(handle); await gate.promise; await persist(); };
    } }, signal);
    starting = server.sessions.start(source).catch(error => error); const handle = await entered.promise;
    assert.equal(source.handle, handle); assert.equal(handle.acceptingInput, false);
    let finished = false; closing = server.close().then(() => { finished = true; });
    await handle.exited; await new Promise(setImmediate);
    assert.equal(await isSameProcess(handle.identity), "gone"); assert.equal(finished, false);
    gate.resolve(); assert.equal((await starting).code, "interrupted"); await closing;
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

test("关闭期间目标恢复失败时保留隔离锁及实例锁，不报告排空成功", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred();
  let switching; let closing; let lock; let handle;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    await server.sessions.start(source); handle = source.handle;
    const target = f.sessionPath("failed-target"); const acquire = handle.acquireWriter;
    handle.acquireWriter = async (...args) => {
      lock = await acquire(...args); const recover = lock.recoverPreviousWriter.bind(lock);
      lock.recoverPreviousWriter = async (...args) => { await recover(...args); entered.resolve(); await gate.promise; throw new Error("注入目标恢复未确认"); };
      return lock;
    };
    switching = handle.bridgeEvent({ type: "shutdown", reason: "resume", target }); await entered.promise;
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    closing = server.close(); const failed = assert.rejects(closing, AggregateError);
    await handle.exited; gate.resolve(); await switching; await failed;
    assert.equal(released, false); assert.equal((await probeSessionWriterLock(target)).held, true);
    assert.equal(await isSameProcess(handle.identity), "gone");
  } finally { gate.resolve(); await switching; await closing?.catch(() => {}); if (handle) await handle.stop(); if (lock) await lock.release(); await server.lock.release(); await f.cleanup(); }
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
  const f = await piFixture(); const server = await startServer(f); let stop; let handle; let locks;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    await server.sessions.start(source); handle = source.handle; stop = handle.proc.stop.bind(handle.proc); locks = [...handle.locks.values()];
    // 保留真实 performStop 的退出和排空生命周期，hostkit 停止本身拒绝且写者仍存活。
    handle.proc.stop = async () => { throw new Error("注入停止未确认"); };
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    await assert.rejects(server.close(), AggregateError); await assert.rejects(server.close(), AggregateError);
    assert.equal(released, false); assert.equal((await probeSessionWriterLock(source.file)).held, true);
  } finally { if (stop) { handle.proc.stop = stop; await stop(); for (const lock of locks) await lock.release(); } await server.lock.release(); await f.cleanup(); }
});

for (const phase of ["process", "verify", "update", "release", "record"]) test(`关闭前真实停止的 ${phase} 失败在退出及登记收尾后仍保留实例锁`, { timeout: 30000 }, async (t) => {
  const f = await piFixture(); const server = await startServer(f); let handle; let lock; let update; let release;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    await server.sessions.start(source); handle = source.handle; lock = handle.current;
    update = lock.update.bind(lock); release = lock.release.bind(lock);
    const stop = handle.proc.stop.bind(handle.proc);
    handle.proc.stop = async (...args) => {
      const report = await stop(...args);
      assert.equal(await isSameProcess(handle.identity), "gone", "故障只在真实进程停止后注入");
      if (phase === "process") throw new Error("注入真实停止失败");
      if (phase === "verify") return { ...report, steps: [...report.steps, { step: "verify", ok: false, at: new Date().toISOString() }] };
      return report;
    };
    if (phase === "update") lock.update = async data => { if (data.state === "stopping") throw new Error("注入停止锁更新失败"); return update(data); };
    if (phase === "release") lock.release = async () => { throw new Error("注入停止锁释放失败"); };
    if (phase === "record") {
      const rm = fs.rm;
      t.mock.method(fs, "rm", async (...args) => { if (args[0] === handle.recordFile) throw new Error("注入运行记录清理失败"); return rm(...args); });
      syncBuiltinESMExports();
    }
    await assert.rejects(handle.stop()); await handle.exited;
    assert.equal(source.handle, undefined, "必须经过真实 performStop 的 onExit");
    const finished = server.sessions.handles.get(handle); await finished?.catch(() => {}); await new Promise(setImmediate);
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (phase === "record") {
      await server.sessions.start(source); const replacement = source.handle; await replacement.stop(); await replacement.drain();
      assert.equal(server.sessions.handles.has(handle), true, "成功重启和退出不能清除旧 handle 的失败");
    }
    let released = false; const releaseInstance = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await releaseInstance(); };
    await assert.rejects(server.close(), AggregateError); await assert.rejects(server.close(), AggregateError);
    assert.equal(released, false); assert.equal(server.sessions.handles.has(handle), true);
    assert.equal((await probeSessionWriterLock(source.file)).held, phase !== "record");
    assert.ok((await readdir(path.join(f.root, "pane", "run"))).includes(handle.identity.runId + ".json"));
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await server.close().catch(() => {});
    if (lock) { lock.update = update; lock.release = release; await release(); }
    await server.lock.release(); await f.cleanup();
  }
});

for (const phase of ["start", "target"]) test(`本实例 ${phase} 恢复隔离阻止关闭，下一实例只诊断旧标记`, { timeout: 30000 }, async () => {
  const f = await piFixture(); let server = await startServer(f); let faultLock;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    if (phase === "target") await server.sessions.start(source);
    const driver = phase === "start" ? server.sessions.driver : source.handle;
    const acquire = driver.acquireWriter;
    driver.acquireWriter = async (...args) => {
      faultLock = await acquire(...args); const recover = faultLock.recoverPreviousWriter.bind(faultLock);
      faultLock.recoverPreviousWriter = async (...args) => { await recover(...args); throw new Error("注入关闭前恢复失败"); };
      return faultLock;
    };
    if (phase === "start") await assert.rejects(server.sessions.start(source), { code: "stopIncomplete" });
    else {
      const handle = source.handle;
      await handle.bridgeEvent({ type: "shutdown", reason: "resume", target: f.sessionPath("failed-before-close") });
      await handle.stop(); await handle.drain();
      await server.sessions.handles.get(handle); await new Promise(setImmediate);
      assert.equal(server.sessions.handles.size, 0, "写者本身已确认停止，失败由实例恢复登记保留");
    }
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    await assert.rejects(server.close(), AggregateError); assert.equal(released, false);
    await faultLock.release(); faultLock = undefined; await server.lock.release();
    server = await startServer(f);
    assert.equal(server.sessions.recoveryDiagnostics.length, 1); assert.match(server.sessions.recoveryDiagnostics[0], /既有写者恢复隔离记录/);
    await server.close();
  } finally { await server.close().catch(() => {}); await faultLock?.release(); await server.lock.release(); await f.cleanup(); }
});

test("spawn 失败后的写锁释放拒绝先于关闭完成，仍保留实例清理失败", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f);
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    const acquire = server.sessions.driver.acquireWriter;
    server.sessions.driver.acquireWriter = async (...args) => {
      const lock = await acquire(...args); const release = lock.release.bind(lock);
      lock.spawnWriter = async () => { throw new Error("注入 spawn 拒绝"); };
      lock.release = async () => { await release(); throw new Error("注入启动清理拒绝"); };
      return lock;
    };
    await assert.rejects(server.sessions.start(source), /注入启动清理拒绝/); await new Promise(setImmediate);
    assert.equal(server.sessions.starts.size, 0); assert.equal(server.sessions.handles.size, 0);
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    await assert.rejects(server.close(), AggregateError); assert.equal(released, false);
  } finally { await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});

for (const phase of ["report", "stop"]) test(`spawn 真实提交失败的 ${phase} 清理结果不被 release 成功覆盖`, { timeout: 30000 }, async (t) => {
  const f = await piFixture(); const server = await startServer(f); let releasedWriter = false; let failedReport; let identity;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    const acquire = server.sessions.driver.acquireWriter;
    server.sessions.driver.acquireWriter = async (...args) => {
      const lock = await acquire(...args); const writeUpdate = lock.writeUpdate.bind(lock);
      const stopFailedWriter = lock.stopFailedWriter.bind(lock); const release = lock.release.bind(lock);
      lock.writeUpdate = patch => {
        if (patch.state === "running") throw new Error("注入 running 记录提交失败");
        return writeUpdate(patch);
      };
      lock.stopFailedWriter = async (proc, error) => {
        identity = proc.identity; const stop = proc.stop.bind(proc);
        proc.stop = async (...args) => {
          const report = await stop(...args);
          const writerState = await isSameProcess(proc.identity);
          t.diagnostic(JSON.stringify({ phase, writerState, hostkitStopReport: report }));
          assert.equal(writerState, "gone", "根进程真实退出后才注入核查失败");
          if (phase === "stop") throw new Error("注入 hostkit 停止拒绝且没有报告");
          failedReport = { ...report, steps: [...report.steps, { step: "snapshot", ok: false, at: new Date().toISOString(), detail: "注入快照核查失败" }] };
          return failedReport;
        };
        return stopFailedWriter(proc, error);
      };
      lock.release = async (...args) => { await release(...args); releasedWriter = true; };
      return lock;
    };
    await assert.rejects(server.sessions.start(source), error => {
      t.diagnostic(inspect(error, { depth: 12 }));
      assert.ok(error instanceof AggregateError); assert.match(error.message, /Cannot stop failed session writer/);
      assert.match(error.errors[0].message, /注入 running 记录提交失败/);
      if (phase === "report") assert.equal(error.errors[1].cause, failedReport);
      else assert.match(error.errors[1].message, /注入 hostkit 停止拒绝且没有报告/);
      return true;
    });
    await new Promise(setImmediate);
    assert.equal(await isSameProcess(identity), "gone"); assert.equal(releasedWriter, true);
    assert.equal((await probeSessionWriterLock(source.file)).held, false);
    assert.equal(server.sessions.starts.size, 0); assert.equal(server.sessions.handles.size, 0);
    let releasedInstance = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { releasedInstance = true; await release(); };
    await assert.rejects(server.close(), AggregateError);
    await assert.rejects(server.close(), AggregateError);
    assert.equal(releasedInstance, false, "成功释放写锁不能清除 spawn 已报告的清理未确认");
  } finally { await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});

test("普通 spawn 拒绝在没有创建进程且真实写锁释放后允许关闭", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const failure = new Error("注入未创建进程的普通 spawn 拒绝"); let releasedWriter = false;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    const acquire = server.sessions.driver.acquireWriter;
    server.sessions.driver.acquireWriter = async (...args) => {
      const lock = await acquire(...args); const release = lock.release.bind(lock);
      lock.spawnWriter = async () => { throw failure; };
      lock.release = async (...args) => { await release(...args); releasedWriter = true; };
      return lock;
    };
    await assert.rejects(server.sessions.start(source), error => error === failure); await new Promise(setImmediate);
    assert.equal(releasedWriter, true); assert.equal((await probeSessionWriterLock(source.file)).held, false);
    assert.equal(server.sessions.starts.size, 0); assert.equal(server.sessions.handles.size, 0);
    assert.deepEqual(server.sessions.cleanupErrors, []);
    let releasedInstance = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { releasedInstance = true; await release(); };
    await server.close(); assert.equal(releasedInstance, true);
  } finally { await server.close(); await f.cleanup(); }
});

for (const phase of ["acquire", "target-update", "clear-queue"]) test(`hostkit ${phase} 的报告错误在后续清理成功后仍由实例保留`, { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); let handle;
  const failure = new Error("注入携带清理报告的 hostkit 拒绝", { cause: { coverage: "snapshot_visible", steps: [{ step: "snapshot", ok: false }], leftovers: [] } });
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const source = server.sessions.records.get(view.ref.id);
    if (phase === "acquire") {
      const acquire = server.sessions.driver.acquireWriter;
      server.sessions.driver.acquireWriter = async (...args) => { const lock = await acquire(...args); await lock.release(); throw failure; };
      await assert.rejects(server.sessions.start(source), error => error === failure);
    } else {
      await server.sessions.start(source); handle = source.handle;
      if (phase === "target-update") {
        const acquire = handle.acquireWriter;
        handle.acquireWriter = async (...args) => {
          const lock = await acquire(...args); const update = lock.update.bind(lock);
          lock.update = async patch => { await update(patch); if (patch.state === "running") throw failure; };
          return lock;
        };
        await assert.rejects(handle.bridgeEvent({ type: "lock", target: f.sessionPath("cleanup-update") }), error => error === failure);
      } else {
        const send = handle.proc.rpc.send.bind(handle.proc.rpc);
        handle.proc.rpc.send = (...args) => { if (args[0].type === "clear_queue") throw failure; return send(...args); };
      }
      await handle.stop(); await handle.drain(); await server.sessions.handles.get(handle);
    }
    await new Promise(setImmediate);
    assert.equal(server.sessions.starts.size, 0); assert.equal(server.sessions.handles.size, 0);
    assert.ok(server.sessions.cleanupErrors.includes(failure));
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    await assert.rejects(server.close(), AggregateError); assert.equal(released, false);
  } finally { await handle?.stop(); await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});

test("运行记录恢复失败由本实例保存，随后关闭不能报告成功", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f);
  try {
    await writeFile(path.join(f.root, "pane", "run", "broken.json"), JSON.stringify({ identity: {} }));
    await assert.rejects(server.sessions.recover(), { code: "invalidRunRecord" });
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    await assert.rejects(server.close(), AggregateError); assert.equal(released, false);
  } finally { await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});

test("重绑定复制出的旧记录不继承 syncing，重新托管后真正取条目", async () => {
  const sessions = Object.create(Sessions.prototype); sessions.assets = new AssetStore("unused");
  sessions.records = new Map(); sessions.files = new Map(); sessions.watch = () => {};
  sessions.pluginHolds = new Map(); sessions.mainListeners = new Set(); sessions.knownMain = new Map();
  const gate = deferred(); const file = path.resolve("sync-source.jsonl"); const destination = path.resolve("sync-target.jsonl");
  const handle = { acceptingInput: true, send: async () => { await gate.promise; return { data: { entries: [] } }; } };
  const source = { id: "source", file, cwd: process.cwd(), model: new SessionModel({ source: "pane", id: "source" }, sessions.assets),
    handle, control: new ControlQueue(), owner: Symbol(), dirty: false, drafts: new Map(), clients: 0, lastActive: 0, holds: new Map(), ui: new Map(), recentExternal: false, closed: false };
  sessions.records.set(source.id, source); sessions.files.set(fileKey(file), source); sessions.pluginHolds.set(source.id, source.holds);
  const syncing = sessions.sync(source); source.dirty = true;
  sessions.rebind(source, handle, { sessionId: "target", sessionFile: destination }, { entries: [] }, "resume");
  const previous = sessions.records.get("source");
  assert.equal(previous.syncing, undefined); assert.equal(previous.dirty, false);
  gate.resolve(); await syncing;
  let reads = 0; previous.handle = { acceptingInput: true, send: async () => { reads++; return { data: { entries: [] } }; } };
  await sessions.sync(previous); assert.equal(reads, 1, "旧记录重新启动后必须执行 get_entries，不能复用已完成的 Promise");
  assert.equal(previous.syncing, undefined); assert.equal(previous.dirty, false);
});
