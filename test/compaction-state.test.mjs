import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionModel } from "../packages/server/dist/model.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
const commands = fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url));

test("手动 compaction_end 的所有结局均空闲，自动压缩继续等待 settled", () => {
  const model = new SessionModel({ source: "pane", id: "compact" }, { detach: structuredClone });
  for (const end of [{ aborted: false, result: {} }, { aborted: true }, { aborted: false, errorMessage: "provider failed" }]) {
    model.apply({ type: "compaction_start", reason: "manual" });
    model.apply({ type: "compaction_end", reason: "manual", willRetry: false, ...end });
    assert.equal(model.status, "idle"); assert.equal(model.inFlight.phase, "idle");
  }
  for (const reason of ["threshold", "overflow"]) {
    model.apply({ type: "compaction_start", reason });
    model.apply({ type: "compaction_end", reason, aborted: false, willRetry: reason === "overflow" });
    assert.equal(model.status, "running"); assert.equal(model.inFlight.phase, "streaming");
    model.apply({ type: "agent_settled" }); assert.equal(model.status, "idle");
  }
});

for (const scenario of ["empty", "extension-cancel", "provider-error"]) test(`手动 compact ${scenario} 拒绝后与真实 pi 一致保持 idle 并可回收`, { timeout: 30000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "待压缩内容".repeat(500) }] } });
  const settingsFile = path.join(f.agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsFile, "utf8")); settings.compaction.keepRecentTokens = 1;
  await writeFile(settingsFile, JSON.stringify(settings));
  const server = await startServer(f, { idleReclaimMs: 0, extraExtensions: [providerPath, commands] });
  try {
    const token = await pair(server);
    const start = await control(server, token, await open(server, token, f), { type: "prompt", message: "/pane-test-wait 1" }); assert.equal(start.code, 200);
    let state = await snapshot(server, token, start.value.snapshot.ref.id);
    if (scenario !== "empty") {
      for (const message of ["第一回合", "第二回合"]) {
        const sent = await control(server, token, state, { type: "prompt", message }); assert.equal(sent.code, 200);
        state = await until(async () => { const s = await snapshot(server, token, state.ref.id); return s.status === "idle" && s.entries.some(e => e.message?.role === "user" && e.message.content.some?.(b => b.text === message)) && s; });
      }
    }
    if (scenario === "provider-error") await f.setScript({ fallback: { segments: [{ type: "error", message: "injected compaction provider failure" }] } });
    const events = []; const off = server.sessions.subscribe(state.ref.id, state.cursor, e => events.push(e.event));
    const result = await control(server, token, state, { type: "compact", ...(scenario === "extension-cancel" ? { customInstructions: "pane-test-cancel" } : {}) });
    assert.equal(result.code, 409, JSON.stringify(result)); assert.equal(result.value.error, "rpcRejected");
    assert.match(result.value.message, scenario === "empty" ? /Nothing to compact/ : scenario === "extension-cancel" ? /cancelled/ : /injected compaction provider failure/);
    const end = events.find(e => e.type === "compaction_end"); assert.ok(end); assert.equal(end.reason, "manual"); assert.equal(end.willRetry, false); assert.equal(end.aborted, scenario === "extension-cancel");
    const after = await snapshot(server, token, state.ref.id); assert.equal(after.status, "idle"); assert.equal(after.inFlight.phase, "idle");
    const real = (await server.sessions.query(state.ref.id, "get_state")).data;
    assert.equal(real.isCompacting, false); assert.equal(real.isStreaming, false);
    assert.equal(events.some(e => e.type === "agent_start" || e.type === "agent_settled"), false, "手动操作没有生成回合补发 settled");
    off(); await server.sessions.reclaim(); assert.equal((await snapshot(server, token, state.ref.id)).readonly, true);
  } finally { await server.close(); await f.cleanup(); }
});
