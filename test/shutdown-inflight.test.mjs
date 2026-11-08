import test from "node:test";
import assert from "node:assert/strict";
import { isSameProcess } from "pi-hostkit";
import { piFixture } from "./fixtures/helpers.mjs";
import { startServer } from "./fixtures/client.mjs";
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

for (const fault of [true, false]) test(`关闭屏障等待已退出写者的在途 RPC${fault ? "并保存迟到清理事实" : "，普通成功不误报"}`, { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const gate = deferred(); const entered = deferred();
  const failure = new Error("注入携带清理事实的迟到 RPC 拒绝", { cause: { coverage: "snapshot_visible", steps: [{ step: "verify", ok: false }], leftovers: [] } });
  let sending; let closing;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const session = server.sessions.records.get(view.ref.id);
    await server.sessions.start(session); const handle = session.handle; const send = handle.proc.rpc.send.bind(handle.proc.rpc);
    let armed = true;
    handle.proc.rpc.send = async (...args) => {
      const response = await send(...args);
      if (armed && args[0].type === "get_state") { armed = false; entered.resolve(); await gate.promise; if (fault) throw failure; }
      return response;
    };
    sending = handle.send({ type: "get_state" }).catch(error => error); await entered.promise;
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    let finished = false; closing = server.close(); closing.then(() => { finished = true; }, () => { finished = true; });
    await handle.exited; await handle.drain(); await new Promise(setImmediate);
    assert.equal(await isSameProcess(handle.identity), "gone"); assert.equal(session.handle, undefined);
    assert.equal(finished, false, "handles 排空不能替代全实例操作屏障"); assert.equal(released, false);
    await assert.rejects(handle.send({ type: "get_state" }), { code: "serverStopping" });
    assert.throws(() => handle.respondUi({ id: "late", cancelled: true }), { code: "serverStopping" });
    gate.resolve(); const result = await sending;
    if (fault) { assert.equal(result, failure); await assert.rejects(closing, AggregateError); await assert.rejects(server.close(), AggregateError); assert.equal(released, false); }
    else { assert.equal(result.success, true); await closing; assert.equal(released, true); }
  } finally { gate.resolve(); await sending; await closing?.catch(() => {}); await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});
