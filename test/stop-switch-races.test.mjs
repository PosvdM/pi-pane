import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { probeSessionWriterLock, isSameProcess } from "pi-hostkit";
import { RequestLedger } from "../packages/server/dist/control.js";
import { fileKey } from "../packages/server/dist/store.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
const commands = fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function setup() {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const target = f.sessionPath("stop-race-target");
  await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "stop-race-target", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
  await utimes(target, new Date(0), new Date(0));
  const server = await startServer(f, { extraExtensions: [providerPath, commands] });
  const token = await pair(server); const b = await open(server, token, f, { sessionFile: target });
  const first = await control(server, token, await open(server, token, f), { type: "prompt", message: "源会话" }); assert.equal(first.code, 200);
  const a = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s; });
  server.sessions.ledger = new RequestLedger(Date.now, 50);
  return { f, target, server, token, a, b };
}
async function final(server, token, route, body) {
  return until(async () => { const r = await request(server, token, route, body); return r.value.status !== "pending" && r; });
}

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
