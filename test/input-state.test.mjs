import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
const commands = fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url));

test("空闲会话的无模型扩展命令及 handled 输入只受理 revision，不留下 running", { timeout: 30000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const server = await startServer(f, { idleReclaimMs: 0, extraExtensions: [providerPath, commands] });
  try {
    const token = await pair(server); const first = await control(server, token, await open(server, token, f), { type: "prompt", message: "启动" }); assert.equal(first.code, 200);
    let state = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s.entries.some(e => e.message?.role === "assistant") && s; });
    const events = []; const off = server.sessions.subscribe(state.ref.id, state.cursor, e => events.push(e));
    for (const message of ["/pane-test-wait 1", "pane-test-handled-input"]) {
      const revision = state.controlRevision;
      const result = await control(server, token, state, { type: "prompt", message }); assert.equal(result.code, 200, JSON.stringify(result));
      assert.equal(result.value.result.handled, true);
      state = await snapshot(server, token, state.ref.id); assert.equal(state.status, "idle"); assert.equal(state.inFlight.phase, "idle"); assert.equal(state.controlRevision, revision + 1);
      const real = await server.sessions.query(state.ref.id, "state"); assert.equal(real.running, false);
    }
    assert.equal(events.some(e => e.event.type === "agent_start" || e.event.type === "pane_status" && e.event.status === "running"), false);
    assert.equal((await readFile(f.env.FAKE_REQUEST_LOG, "utf8")).split("\n").filter(line => line && JSON.parse(line).kind === "request").length, 1);
    off(); await server.sessions.reclaim(); assert.equal((await snapshot(server, token, state.ref.id)).readonly, true, "handled 后仍能按空闲规则回收");
  } finally { await server.close(); await f.cleanup(); }
});

test("空闲会话 prompt 预检被拒绝不改变运行阶段", { timeout: 30000 }, async () => {
  const f = await piFixture();
  const settings = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8")); settings.defaultProvider = "missing-test-provider"; settings.defaultModel = "missing-test-model";
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify(settings));
  const server = await startServer(f, { extraExtensions: [commands] });
  try {
    const token = await pair(server); const first = await control(server, token, await open(server, token, f), { type: "prompt", message: "/pane-test-wait 1" }); assert.equal(first.code, 200, JSON.stringify(first));
    const state = await snapshot(server, token, first.value.snapshot.ref.id); assert.equal(state.status, "idle");
    const events = []; const off = server.sessions.subscribe(state.ref.id, state.cursor, e => events.push(e));
    const denied = await control(server, token, state, { type: "prompt", message: "无可用模型的预检" }); assert.equal(denied.code, 409); assert.equal(denied.value.error, "rpcRejected");
    const after = await snapshot(server, token, state.ref.id); assert.equal(after.status, "idle"); assert.equal(after.inFlight.phase, "idle"); assert.equal(after.controlRevision, state.controlRevision + 1);
    assert.equal((await server.sessions.query(state.ref.id, "state")).running, false);
    assert.equal(events.some(e => e.event.type === "pane_status" && e.event.status === "running"), false); off();
  } finally { await server.close(); await f.cleanup(); }
});
