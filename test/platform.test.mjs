import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isSameProcess, stopByIdentity } from "pi-hostkit";
import { piFixture, until, providerPath, delay } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
async function records(file) { try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
test("忽略 abort 的工具启动真实 shell 与脱离进程组后代，StopReport 返回后独立核对退出", { timeout: 60000 }, async t => {
 const f = await piFixture(); const oracle = path.join(f.root, "descendants.jsonl"); const slash = s => s.replaceAll("\\", "/");
 const command = '"' + slash(process.execPath) + '" "' + slash(fileURLToPath(new URL("./fixtures/descendant.mjs", import.meta.url))) + '" "' + slash(oracle) + '"';
 await f.setScript({ turns: [{ segments: [{ type: "toolCall", name: "pane_test_shell", arguments: { command } }] }] });
 const server = await startServer(f, { snapshotIntervalMs: 50, extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/hang-tool.ts", import.meta.url))] }); let identities = [];
 try {
  const token = await pair(server); const initial = await open(server, token, f); const sent = await control(server, token, initial, { type: "prompt", message: "阻塞工具进程树" }); assert.equal(sent.code, 200);
  const id = sent.value.snapshot.ref.id; identities = await until(async () => { const rows = await records(oracle); return rows.length >= 2 && rows; }, 15000);
  await delay(200); const stopped = await control(server, token, await snapshot(server, token, id), { type: "stop" });
  if (stopped.code !== 200) t.diagnostic(JSON.stringify({ response: stopped, stopReports: server.sessions.reports, identities }));
  assert.equal(stopped.code, 200, JSON.stringify(stopped));
  const report = server.sessions.reports.at(-1); assert.equal("stopReport" in stopped.value, false); assert.equal(report.leftovers.length, 0); assert.ok(report.steps.some(s => s.step === "abort" && !s.ok));
  const began = performance.now(); const observations = [];
  async function gone() { const states = await Promise.all(identities.map(identity => isSameProcess(identity))); observations.push({ elapsedMs: Math.round(performance.now() - began), states }); return states.every(state => state === "gone"); }
  assert.ok(await gone(), "StopReport 返回后必须立即确认已知后代退出");
  t.diagnostic(JSON.stringify({ coverage: report.coverage, leftovers: report.leftovers, observations, observationLimitMs: 0 }));
 } finally {
  await server.close(); identities = await records(oracle);
  for (const identity of identities) if (await isSameProcess(identity) === "alive") await stopByIdentity(identity, { termGraceMs: 0 });
  await f.cleanup();
 }
});
