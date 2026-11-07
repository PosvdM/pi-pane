import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { probeSessionWriterLock, isSameProcess } from "pi-hostkit";
import { RequestLedger } from "../packages/server/dist/control.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";

test("操作等待到期后连接中断返回结果未知，不固定为普通失败", { timeout: 30000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url))] });
  try {
    const token = await pair(server); const initial = await open(server, token, f);
    const first = await control(server, token, initial, { type: "prompt", message: "启动" }); assert.equal(first.code, 200);
    const state = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s; });
    server.sessions.ledger = new RequestLedger(Date.now, 50);
    const route = "/api/sessions/" + state.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: state.cursor.epoch, expectedRevision: state.controlRevision, command: { type: "prompt", message: "/pane-test-wait 10000" } };
    const pending = await request(server, token, route, body); assert.deepEqual(pending.value, { status: "pending" });
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
    const lock = await probeSessionWriterLock(state.sessionFile); process.kill(lock.record.writer.pid, "SIGKILL");
    const final = await until(async () => { const r = await request(server, token, route, body); return r.value.status !== "pending" && r; });
    assert.equal(final.code, 503); assert.equal(final.value.error, "rpcResultUnknown");
    assert.deepEqual((await request(server, token, route, body)).value, final.value);
  } finally { await server.close(); await f.cleanup(); }
});

for (const type of ["stop", "close"]) test(`挂起的扩展 RPC 经 pane ${type} 抢占结束，无遗留进程且结果保持未知`, { timeout: 30000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url))] });
  try {
    const token = await pair(server); const initial = await open(server, token, f);
    const first = await control(server, token, initial, { type: "prompt", message: "启动" }); assert.equal(first.code, 200);
    const state = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s; });
    server.sessions.ledger = new RequestLedger(Date.now, 50);
    const route = "/api/sessions/" + state.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: state.cursor.epoch, expectedRevision: state.controlRevision, command: { type: "prompt", message: "/pane-test-hang" } };
    assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
    const writer = (await probeSessionWriterLock(state.sessionFile)).record.writer;
    const current = await snapshot(server, token, state.ref.id);
    const queued = { requestId: randomUUID(), expectedEpoch: current.cursor.epoch, expectedRevision: current.controlRevision, command: { type: "set_session_name", name: "不得执行" } };
    assert.deepEqual((await request(server, token, route, queued)).value, { status: "pending" });
    const stop = { requestId: randomUUID(), expectedEpoch: current.cursor.epoch, expectedRevision: current.controlRevision, command: { type } };
    let result = await request(server, token, route, stop);
    if (result.value.status === "pending") result = await until(async () => { const r = await request(server, token, route, stop); return r.value.status !== "pending" && r; });
    assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.status, "done");
    assert.ok(result.value.stopReport); assert.deepEqual(result.value.stopReport.leftovers, []);
    assert.equal(await isSameProcess(writer), "gone"); assert.equal((await probeSessionWriterLock(state.sessionFile)).held, false);
    const final = await until(async () => { const r = await request(server, token, route, body); return r.value.status !== "pending" && r; });
    assert.equal(final.code, 503); assert.equal(final.value.error, "rpcResultUnknown");
    assert.deepEqual((await request(server, token, route, body)).value, final.value);
    const canceled = await request(server, token, route, queued); assert.equal(canceled.value.error, "controlPreempted");
    assert.deepEqual((await request(server, token, route, queued)).value, canceled.value);
    assert.notEqual((await snapshot(server, token, state.ref.id)).inFlight.phase, "stopping");
  } finally { await server.close(); await f.cleanup(); }
});
