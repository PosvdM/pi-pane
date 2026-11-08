import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isSameProcess, probeSessionWriterLock } from "pi-hostkit";
import { RequestLedger } from "../packages/server/dist/control.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer } from "./fixtures/client.mjs";

async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`关闭等待超过测试上限 ${ms} 毫秒`)), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const failure of ["reject", "leftovers", "healthy"]) test(`真实挂起控制 RPC 的关闭有界返回：${failure}`, { timeout: 30000 }, async () => {
  const f = await piFixture();
  const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url))] });
  let handle; let stop; let locks; let closing;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const session = server.sessions.records.get(view.ref.id);
    await server.sessions.start(session); handle = session.handle; stop = handle.proc.stop.bind(handle.proc); locks = [...handle.locks.values()];
    server.sessions.ledger = new RequestLedger(Date.now, 50);
    const body = { requestId: randomUUID(), expectedEpoch: session.model.epoch, expectedRevision: session.model.controlRevision,
      command: { type: "prompt", message: "/pane-test-hang" } };
    assert.deepEqual(await server.sessions.command(session.id, body), { status: "pending" });
    await until(async () => { try { await access(path.join(f.root, "hang-entered")); return true; } catch { return false; } });
    assert.deepEqual(await server.sessions.command(session.id, body), { status: "pending" }, "真实扩展已进入永久等待");
    if (failure === "reject") handle.proc.stop = async () => { throw new Error("注入真实 proc.stop 拒绝"); };
    if (failure === "leftovers") handle.proc.stop = async () => ({ coverage: handle.proc.coverage, steps: [], leftovers: [handle.identity] });
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    closing = server.close();
    if (failure === "healthy") await within(closing, 9000);
    else {
      const error = await within(closing.then(() => assert.fail("关闭不能成功"), error => error), 9000);
      assert.ok(error instanceof AggregateError);
      assert.equal(server.close(), closing, "重复 close 复用同一失败 Promise");
      await assert.rejects(server.close(), e => e === error);
      assert.equal(await isSameProcess(handle.identity), "alive");
      assert.ok((await readdir(path.join(f.root, "pane", "run"))).includes(handle.identity.runId + ".json"));
    }
    assert.equal(server.http.listening, false);
    assert.equal(released, failure === "healthy");
    assert.equal((await probeSessionWriterLock(session.file)).held, failure !== "healthy");
    await assert.rejects(server.sessions.command(session.id, body), { code: "rpcResultUnknown" });
    await assert.rejects(server.sessions.command(session.id, body), { code: "rpcResultUnknown" });
    if (failure === "healthy") assert.equal(await isSameProcess(handle.identity), "gone");
  } finally {
    if (stop) { handle.proc.stop = stop; await stop(); for (const lock of locks) await lock.release(); }
    await closing?.catch(() => {}); await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
  }
});

test("永久在途登记超过关闭上限时列出 kind 和来源，保留锁与运行记录", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); let handle; let stop; let locks;
  try {
    const view = await server.sessions.open({ cwd: f.cwd }); const session = server.sessions.records.get(view.ref.id);
    await server.sessions.start(session); handle = session.handle; stop = handle.proc.stop.bind(handle.proc); locks = [...handle.locks.values()];
    // 真实停止边界永久挂起，与停止后额外的未知生产者分别覆盖有界等待。
    handle.proc.stop = () => new Promise(() => {});
    void server.sessions.inflight.run("test.never-finishes", () => new Promise(() => {}));
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    const started = Date.now(); const closing = server.close();
    const error = await within(closing.then(() => assert.fail("超时不能当作排空成功"), error => error), 9000);
    assert.ok(error instanceof AggregateError);
    const timeout = error.errors.find(e => e.code === "shutdownTimeout"); assert.ok(timeout, String(error));
    assert.ok(Date.now() - started >= 7500, "停止宽限 500ms + 7000ms 收尾预算");
    assert.match(timeout.message, /test\.never-finishes/); assert.match(timeout.message, /shutdown-bounded\.test\.mjs/);
    assert.ok(timeout.detail.pending.some(item => item.kind === "test.never-finishes" && item.source.includes("shutdown-bounded.test.mjs")));
    assert.equal(released, false); assert.equal(server.http.listening, false);
    assert.equal((await probeSessionWriterLock(session.file)).held, true);
    assert.ok((await readdir(path.join(f.root, "pane", "run"))).includes(handle.identity.runId + ".json"));
    assert.equal(server.close(), closing); await assert.rejects(server.close(), e => e === error);
  } finally {
    if (stop) { handle.proc.stop = stop; await stop(); for (const lock of locks) await lock.release(); }
    await server.lock.release(); await f.cleanup();
  }
});

test("停止结束后的永久登记也受同一关闭上限约束", { timeout: 15000 }, async () => {
  const f = await piFixture(); const server = await startServer(f);
  try {
    void server.sessions.inflight.run("test.post-stop-never", () => new Promise(() => {}));
    let released = false; const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { released = true; await release(); };
    const closing = server.close();
    const error = await within(closing.then(() => assert.fail(), error => error), 9000);
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors.find(e => e.code === "shutdownTimeout").message, /test.post-stop-never/);
    assert.equal(server.http.listening, false); assert.equal(released, false);
    await assert.rejects(server.close(), e => e === error);
  } finally { await server.lock.release(); await f.cleanup(); }
});
