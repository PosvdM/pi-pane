import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isSameProcess, probeSessionWriterLock, acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock } from "pi-hostkit";
import { piFixture, until, delay, providerPath } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
const faultPath = fileURLToPath(new URL("./fixtures/bridge-fault.ts", import.meta.url));
async function records(file) { try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
async function faultFixture(mode) {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "回复" }] } });
  f.env.PANE_TEST_FAULT = mode; f.env.PANE_TEST_FAULT_LOG = path.join(f.root, "fault.jsonl"); f.env.PANE_TEST_TARGET = f.sessionPath("target");
  await writeFile(f.env.PANE_TEST_TARGET, JSON.stringify({ type: "session", version: 3, id: "target", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "message", id: "target-user", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "目标消息", timestamp: Date.now() } }) + "\n");
  await utimes(f.env.PANE_TEST_TARGET, new Date(0), new Date(0));
  const settings = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8")); settings.extensions = [faultPath]; await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify(settings)); return f;
}
for (const mode of ["bad-ticket", "stolen-ticket", "reject-callback", "no-ready", "timer-switch"]) {
  test(`首次 pane-bridge 故障 ${mode}：输入门禁、超时清理和遗留锁恢复`, { timeout: 45000 }, async () => {
    const f = await faultFixture(mode); const server = await startServer(f, { readyTimeoutMs: 3000, ...(["bad-ticket", "stolen-ticket"].includes(mode) ? { extensionPath: fileURLToPath(new URL("./fixtures/bridge-wrapper.ts", import.meta.url)) } : {}) });
    if (mode === "reject-callback") server.broker.event = async () => { throw Object.assign(new Error("测试拒绝回连"), { status: 403 }); };
    try {
      const token = await pair(server); const initial = await open(server, token, f); const result = control(server, token, initial, { type: "prompt", message: "不允许发送" });
      const lock = await until(async () => { const p = await probeSessionWriterLock(initial.sessionFile); return p.held && p.record?.writer && p; }); const writer = lock.record.writer;
      if (["no-ready", "timer-switch"].includes(mode)) {
        await until(async () => (await records(f.env.PANE_TEST_FAULT_LOG)).some(r => r.readyAttempt));
        const before = await records(f.env.PANE_TEST_FAULT_LOG); assert.equal(before.some(r => r.rpcInput), false);
        assert.equal((await probeSessionWriterLock(initial.sessionFile)).held, true);
      }
      const response = await result; assert.equal(response.code, 503, JSON.stringify(response));
      const interrupted = await until(async () => { const s = await snapshot(server, token, initial.ref.id); return s.status === "interrupted" && s; });
      assert.equal(interrupted.readonly, true); await until(async () => await isSameProcess(writer) === "gone", 2000);
      const audit = await records(f.env.PANE_TEST_FAULT_LOG); assert.equal(audit.some(r => r.rpcInput && !["clear_queue", "abort"].includes(r.rpcInput)), false, JSON.stringify(audit));
      assert.equal((await records(f.env.FAKE_REQUEST_LOG)).filter(r => r.kind === "request").length, 0);
      if (mode === "timer-switch") {
        assert.deepEqual(audit.filter(r => r.timer).map(r => r.timer), ["new", "resume", "fork"], JSON.stringify(audit));
        for (const name of (await readdir(path.join(f.home, ".pi/hostkit/locks"))).filter(f => f.endsWith(".json"))) {
          const shared = JSON.parse(await readFile(path.join(f.home, ".pi/hostkit/locks", name), "utf8"));
          if (shared.writer) assert.equal(await isSameProcess(shared.writer), "gone");
        }
      }
      const recovered = await acquireSessionWriterLock(initial.sessionFile, { app: "pi-pane", identity: currentProcessIdentity("test-next") }); assert.ok(isSessionWriterLock(recovered));
      assert.equal(await recovered.recoverPreviousWriter(), "none"); await recovered.release();
    } finally { await server.close(); await f.cleanup(); }
  });
}
for (const mode of ["reload-no-ready", "reload-disconnect", "switch-no-ready", "switch-disconnect"]) {
  test(`替换中的 pane-bridge 故障 ${mode}：新实例未就绪时停止并保留只读视图`, { timeout: 45000 }, async () => {
    const f = await faultFixture(mode); const server = await startServer(f, { readyTimeoutMs: 3000 });
    try {
      const token = await pair(server); const initial = await open(server, token, f); const first = await control(server, token, initial, { type: "prompt", message: "正常输入" }); assert.equal(first.code, 200, JSON.stringify(first));
      const id = first.value.snapshot.ref.id; await until(async () => (await snapshot(server, token, id)).status === "idle");
      const state = await snapshot(server, token, id); const command = mode.startsWith("reload") ? "/pane-test-reload" : "/pane-test-new";
      const result = await control(server, token, state, { type: "prompt", message: command }); assert.equal(result.code, 200, JSON.stringify(result));
      await until(async () => (await records(f.env.PANE_TEST_FAULT_LOG)).some(r => r.readyAttempt > 1));
      const record = await probeSessionWriterLock(state.sessionFile); assert.equal(record.held, true); assert.ok(record.record.writer);
      const during = await control(server, token, await snapshot(server, token, id), { type: "prompt", message: "不能送入未就绪实例" }); assert.equal(during.code, 409);
      const done = await until(async () => { const s = await snapshot(server, token, id); return s.status === "interrupted" && s; }, 10000);
      assert.equal(done.readonly, true); await until(async () => await isSameProcess(record.record.writer) === "gone", 2000);
      assert.equal((await records(f.env.FAKE_REQUEST_LOG)).filter(r => r.kind === "request").length, 1);
      assert.equal((await probeSessionWriterLock(state.sessionFile)).held, false);
      assert.equal(server.sessions.reports.at(-1).leftovers.length, 0);
    } finally { await server.close(); await f.cleanup(); }
  });
}
