import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { probeSessionWriterLock } from "pi-hostkit";
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
