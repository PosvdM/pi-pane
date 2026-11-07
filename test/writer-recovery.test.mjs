import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock, probeSessionWriterLock, sessionLocksDir } from "pi-hostkit";
import { RpcSubprocessDriver } from "../packages/server/dist/driver.js";
import { fileKey } from "../packages/server/dist/store.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";

for (const switching of [false, true]) test(`不完整恢复报告在${switching ? "目标切换" : "首次拉起"}保留旧身份、锁和错误`, { timeout: 45000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const target = f.sessionPath("recovery-target");
  const oldWriter = { ...currentProcessIdentity("previous-writer"), startTime: "0" };
  await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "recovery-target", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
  await utimes(target, new Date(0), new Date(0));
  await mkdir(sessionLocksDir(), { recursive: true });
  const sharedPath = path.join(sessionLocksDir(), "session-" + createHash("sha256").update(fileKey(target)).digest("hex") + ".json");
  await writeFile(sharedPath, JSON.stringify({ version: 1, sessionFile: target, host: { app: "pi-agora", identity: currentProcessIdentity("old-host") }, writer: oldWriter, state: "running", updatedAt: new Date().toISOString() }));
  const acquireWithFault = async (file, host) => {
    const lock = await acquireSessionWriterLock(file, host);
    if (isSessionWriterLock(lock) && fileKey(file) === fileKey(target)) {
      const recover = lock.recoverPreviousWriter.bind(lock);
      lock.recoverPreviousWriter = async opts => {
        const result = await recover(opts);
        // 注入 hostkit 接受但 pane 必须拒绝的报告；其余锁和 RPC 均使用真实实现。
        lock.recoveryReports.push({ coverage: "snapshot_visible", leftovers: [], steps: [{ step: "snapshot", ok: false, at: new Date().toISOString(), detail: "injected enumeration failure" }] });
        return result;
      };
    }
    return lock;
  };
  const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url))] });
  server.sessions.driver = new RpcSubprocessDriver(server.broker, server.sessions.options, acquireWithFault);
  try {
    const token = await pair(server); const initial = await open(server, token, f, switching ? {} : { sessionFile: target });
    let state = initial;
    if (switching) {
      const first = await control(server, token, initial, { type: "prompt", message: "原会话" }); assert.equal(first.code, 200, JSON.stringify(first));
      state = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s; });
    }
    const result = await control(server, token, state, { type: "prompt", message: switching ? "/pane-test-resume " + target : "禁止拉起" });
    if (switching) { assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.sessionFile, state.sessionFile); }
    else { assert.equal(result.code, 503); assert.equal(result.value.error, "stopIncomplete"); }
    const held = await probeSessionWriterLock(target); assert.equal(held.held, true); assert.equal(held.record.state, "stopping"); assert.deepEqual(held.record.writer, oldWriter);
    const next = await acquireSessionWriterLock(target, { app: "pi-agora", identity: currentProcessIdentity("next-host") }); assert.equal(isSessionWriterLock(next), false, "不完整恢复不能放入第二个写者");
    const diagnostics = (await readdir(path.join(f.root, "pane/recovery"))).filter(name => name.endsWith(".json")); assert.equal(diagnostics.length, 1);
    const saved = JSON.parse(await readFile(path.join(f.root, "pane/recovery", diagnostics[0]), "utf8")); assert.deepEqual(saved.previous.writer, oldWriter); assert.match(saved.error, /保留写锁/); assert.equal(saved.reports[0].steps[0].ok, false);
    const retry = await open(server, token, f, { sessionFile: target });
    const denied = await control(server, token, retry, { type: "prompt", message: "仍须阻止" }); assert.equal(denied.code, 503); assert.equal(denied.value.error, "stopIncomplete");
    assert.equal((await probeSessionWriterLock(target)).record.state, "stopping");
  } finally { await server.close(); await f.cleanup(); }
});
