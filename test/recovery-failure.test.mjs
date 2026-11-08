import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock, probeSessionWriterLock, sessionLocksDir, spawnManaged, isSameProcess } from "pi-hostkit";
import { RpcSubprocessDriver } from "../packages/server/dist/driver.js";
import { fileKey } from "../packages/server/dist/store.js";
import { piFixture, providerPath, containment } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control } from "./fixtures/client.mjs";

for (const fault of ["failed", "throw"]) test(`hostkit 恢复 ${fault} 真正解锁后存档隔离，重启和其他宿主仍检查旧写者`, { timeout: 45000 }, async () => {
  const f = await piFixture(); const target = f.sessionPath("recovery-failure");
  await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "recovery-failure", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
  const old = await spawnManaged({ argv: [f.install.cliEntry, "--mode", "rpc", "--session", target, "-e", providerPath], cwd: f.cwd, env: f.env,
    runId: randomUUID(), instanceId: "previous-host", containment });
  await old.rpc.send({ type: "get_state" }, { timeoutMs: 10000 });
  await utimes(target, new Date(0), new Date(0));
  await mkdir(sessionLocksDir(), { recursive: true });
  const key = createHash("sha256").update(fileKey(target)).digest("hex");
  const shared = path.join(sessionLocksDir(), `session-${key}.json`);
  const previous = { version: 1, sessionFile: target, host: { app: "pi-agora", identity: currentProcessIdentity("old-host") }, writer: old.identity, state: "running", updatedAt: new Date().toISOString() };
  await writeFile(shared, JSON.stringify(previous));
  let attempts = 0;
  const inject = lock => {
    // 在真实 StopReport 之后注入停止失败；外层 recoverPreviousWriter 保持原样，执行 hostkit 自己的 abandon 分支。
    const stop = lock.stopWriter.bind(lock);
    lock.stopWriter = async (...args) => {
      attempts++;
      const result = await stop(...args);
      if (!lock.recoveryReports.length) lock.recoveryReports.push({ coverage: "snapshot_visible", steps: [], leftovers: [] });
      lock.recoveryReports.at(-1).steps.push({ step: "verify", ok: false, at: new Date().toISOString(), detail: `injected ${fault}` });
      if (fault === "throw") throw new Error("injected recovery exception");
      lock.recoveryReports.at(-1).leftovers.push(old.identity);
      return "failed";
    };
    return lock;
  };
  let server = await startServer(f);
  server.sessions.driver = new RpcSubprocessDriver(server.broker, server.sessions.options, async (...args) => {
    const lock = await acquireSessionWriterLock(...args); return isSessionWriterLock(lock) ? inject(lock) : lock;
  });
  try {
    let token = await pair(server); let initial = await open(server, token, f, { sessionFile: target });
    const denied = await control(server, token, initial, { type: "prompt", message: "禁止拉起" });
    assert.equal(denied.code, 503); assert.equal(denied.value.error, "stopIncomplete"); assert.equal(attempts, 1);
    assert.equal((await probeSessionWriterLock(target)).held, false, "hostkit 失败路径已经释放内核锁");
    assert.deepEqual(JSON.parse(await readFile(shared, "utf8")), previous, "旧共享记录未被改写");
    const diagnostic = path.join(f.root, "pane/recovery", key + ".json");
    const saved = JSON.parse(await readFile(diagnostic, "utf8"));
    assert.deepEqual(saved.previous.writer, old.identity); assert.match(saved.error, fault === "throw" ? /injected recovery exception/ : /恢复失败/);
    assert.ok(saved.reports.at(-1).steps.some(step => !step.ok)); assert.equal(await isSameProcess(old.identity), "gone");
    const next = await acquireSessionWriterLock(target, { app: "pi-agora", identity: currentProcessIdentity("next-host") });
    assert.ok(isSessionWriterLock(next)); assert.deepEqual(next.previous.writer, old.identity);
    await assert.rejects(next.spawnWriter({ argv: [], cwd: f.cwd, env: f.env, runId: randomUUID(), instanceId: "next-host" }), /lock is acquired/);
    inject(next);
    if (fault === "throw") await assert.rejects(next.recoverPreviousWriter(), /injected recovery exception/);
    else assert.equal(await next.recoverPreviousWriter(), "failed");
    assert.equal(attempts, 2, "下一宿主仍执行旧写者恢复检查");
    assert.deepEqual(JSON.parse(await readFile(shared, "utf8")), previous);
    await assert.rejects(server.close(), AggregateError); await server.lock.release();
    server = await startServer(f); assert.equal(server.sessions.recoveryDiagnostics.length, 1); token = await pair(server);
    initial = await open(server, token, f, { sessionFile: target });
    const retry = await control(server, token, initial, { type: "prompt", message: "重启也须隔离" });
    assert.equal(retry.code, 503); assert.equal(retry.value.error, "stopIncomplete"); assert.equal(attempts, 2);
    assert.equal(server.sessions.snapshot(initial.ref.id).readonly, true);
    assert.deepEqual(JSON.parse(await readFile(diagnostic, "utf8")), saved);
  } finally { await server.close().catch(() => {}); await server.lock.release(); await old.stop({ abortTimeoutMs: 100, graceMs: 100, termGraceMs: 100 }); await f.cleanup(); }
});
