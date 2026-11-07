import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import path from "node:path";
import { isSameProcess, linuxCgroupSupport } from "pi-hostkit";
import { readSession } from "../packages/server/dist/store.js";
import { piFixture, until, containment, providerPath, delay } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
const hung = { fallback: { ignoreAbort: true, segments: [{ type: "text", chunks: ["保留的流式内容", { text: "后续", delayMs: 30000 }] }, { type: "hang" }] } };
const quick = { fallback: { segments: [{ type: "text", text: "恢复完成" }] } };
const text = (snapshot) => JSON.stringify(snapshot.inFlight?.assistant?.blocks ?? []);
async function identity(fixture) {
  const dir = path.join(fixture.root, "pane/run"); const files = (await readdir(dir)).filter(f => f.endsWith(".json"));
  assert.equal(files.length, 1); return JSON.parse(await readFile(path.join(dir, files[0]), "utf8")).identity;
}
async function started(server, token, fixture) {
  const initial = await open(server, token, fixture); const result = await control(server, token, initial, { type: "prompt", message: "开始流式输出" });
  assert.equal(result.code, 200, JSON.stringify(result)); const id = result.value.snapshot.ref.id;
  await until(async () => { const s = await snapshot(server, token, id); return text(s).includes("保留的流式内容") && s; }, 20000); return id;
}

test("流式输出中 pi 被杀：保留中断内容，再次发送恢复", { timeout: 60000 }, async () => {
  const f = await piFixture(hung); const server = await startServer(f);
  try {
    const token = await pair(server); const id = await started(server, token, f); const writer = await identity(f);
    process.kill(writer.pid, "SIGKILL");
    const interrupted = await until(async () => { const s = await snapshot(server, token, id); return s.status === "interrupted" && s; }, 15000);
    assert.equal(interrupted.readonly, true); assert.match(JSON.stringify(interrupted.unfinishedPartials), /保留的流式内容/);
    await f.setScript(quick);
    // 只读 watcher 可能先于重启读取最后一批落盘内容并更换 epoch；明确拒绝后按新快照重新确认。
    let resumed = await control(server, token, interrupted, { type: "prompt", message: "继续" });
    if (resumed.code === 409) {
      assert.equal(resumed.value.error, "epochChanged");
      resumed = await control(server, token, await snapshot(server, token, id), { type: "prompt", message: "继续" });
    }
    assert.equal(resumed.code, 200, JSON.stringify(resumed));
    await until(async () => { const s = await snapshot(server, token, id); return s.status === "idle" && JSON.stringify(s.entries).includes("恢复完成"); });
    assert.equal(await isSameProcess(writer), "gone");
  } finally { await server.close(); await f.cleanup(); }
});

test("停止不响应 abort 的 pi：清空含图片草稿队列并按覆盖范围确认退出", { timeout: 60000 }, async () => {
  const f = await piFixture(hung); const server = await startServer(f);
  try {
    if (process.env.HOSTKIT_TEST_REQUIRE_CGROUP === "1") assert.ok(await linuxCgroupSupport(), "CI 必须使用 cgroup");
    const token = await pair(server); const id = await started(server, token, f); const writer = await identity(f);
    const queued = await control(server, token, await snapshot(server, token, id), { type: "follow_up", message: "排队的文字" }); assert.equal(queued.code, 200, JSON.stringify(queued));
    const stopped = await control(server, token, await snapshot(server, token, id), { type: "stop" });
    assert.equal(stopped.code, 200, JSON.stringify(stopped)); assert.deepEqual(stopped.value.clearedText, ["排队的文字"]);
    const report = stopped.value.stopReport; assert.ok(report); assert.equal(report.leftovers.length, 0);
    assert.equal(report.coverage, process.platform === "win32" ? "job_object" : process.platform === "linux" && containment !== "snapshot" && await linuxCgroupSupport() ? "cgroup" : "snapshot_visible");
    assert.ok(report.steps.some(s => s.step === "abort" && !s.ok));
    await until(async () => await isSameProcess(writer) === "gone", process.platform === "win32" ? 2000 : 1000);
    assert.equal((await snapshot(server, token, id)).status, "interrupted");
  } finally { await server.close(); await f.cleanup(); }
});

for (const { name, commands, rpcTypes } of [
  { name: "send/send", commands: [{ type: "steer", message: "第一方" }, { type: "follow_up", message: "第二方" }], rpcTypes: ["steer", "follow_up"] },
  { name: "send/stop", commands: [{ type: "follow_up", message: "发送方" }, { type: "stop" }], rpcTypes: ["follow_up", "stop"] },
  { name: "model/send", commands: [{ type: "set_model", provider: "p0-fake", modelId: "scripted" }, { type: "follow_up", message: "模型竞态" }], rpcTypes: ["set_model", "follow_up"] },
]) test(`两个标签页 ${name} 竞争：revision 败方未执行，更新快照后只执行一次`, { timeout: 60000 }, async () => {
  const f = await piFixture(hung); f.env.PANE_RPC_AUDIT = path.join(f.root, "rpc.jsonl");
  const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/rpc-audit.ts", import.meta.url))] });
  const stopping = []; let unsubscribe;
  const executionCounts = async () => {
    const log = (await readFile(f.env.PANE_RPC_AUDIT, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    // 强停会在驱动清理时再次发送 clear_queue；停止命令按进入 stopping 的次数计数。
    return rpcTypes.map(type => type === "stop" ? stopping.length : log.filter(record => record.type === type).length);
  };
  try {
    const tokens = [await pair(server), await pair(server)]; const id = await started(server, tokens[0], f);
    const state = await snapshot(server, tokens[0], id);
    unsubscribe = server.sessions.subscribe(id, state.cursor, ({ event }) => { if (event.type === "pane_status" && event.phase === "stopping") stopping.push(event); });
    const before = await executionCounts();
    const requestIds = commands.map(() => randomUUID());
    const results = await Promise.all(commands.map((command, i) => control(server, tokens[i], state, command, { requestId: requestIds[i] })));
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409], JSON.stringify(results));
    const loser = results.findIndex(r => r.code === 409); const winner = 1 - loser;
    assert.equal(results[loser].value.error, "revisionChanged");
    const after = await executionCounts();
    assert.equal(after[loser], before[loser], `${name} 败方命令不应执行`);
    assert.equal(after[winner], before[winner] + 1, `${name} 胜方命令应执行一次`);
    const fresh = await snapshot(server, tokens[loser], id); assert.notEqual(fresh.controlRevision, state.controlRevision);
    const retryId = randomUUID(); assert.ok(!requestIds.includes(retryId));
    const retried = await control(server, tokens[loser], fresh, commands[loser], { requestId: retryId });
    assert.equal(retried.code, 200, JSON.stringify(retried));
    assert.equal((await executionCounts())[loser], before[loser] + 1, `${name} 败方重试应执行一次`);
    const duplicate = await control(server, tokens[winner], fresh, commands[loser], { requestId: retryId });
    assert.deepEqual(duplicate, retried);
    const final = await executionCounts();
    assert.equal(final[loser], before[loser] + 1, `${name} 重复重试不应再次执行`);
    assert.equal(final[winner], before[winner] + 1);
  } finally { unsubscribe?.(); await server.close(); await f.cleanup(); }
});

test("重复 requestId 在执行中返回 pending，完成后复用结果且只执行一次", { timeout: 60000 }, async () => {
  const f = await piFixture(hung); const server = await startServer(f);
  try {
    const token = await pair(server); const second = await pair(server); const id = await started(server, token, f);
    const state = await snapshot(server, token, id); const requestId = randomUUID();
    const body = { requestId, expectedEpoch: state.cursor.epoch, expectedRevision: state.controlRevision, command: { type: "stop" } };
    const route = "/api/sessions/" + id + "/control"; const first = request(server, token, route, body);
    await until(async () => (await snapshot(server, token, id)).inFlight.phase === "stopping");
    const pending = await request(server, second, route, body); assert.deepEqual(pending.value, { status: "pending" });
    const finished = await first; assert.equal(finished.code, 200, JSON.stringify(finished));
    const duplicate = await request(server, second, route, body); assert.deepEqual(duplicate.value, finished.value);
    const conflict = await request(server, token, route, { ...body, command: { type: "prompt", message: "不允许" } }); assert.equal(conflict.code, 409); assert.equal(conflict.value.error, "idempotencyConflict");
    const log = (await readFile(f.env.FAKE_REQUEST_LOG, "utf8")).trim().split("\n").map(JSON.parse); assert.equal(log.filter(r => r.kind === "request").length, 1);
  } finally { await server.close(); await f.cleanup(); }
});

test("断电截断文件可只读打开和临时副本 fork，源字节不变且 parentSession 修正", { timeout: 60000 }, async () => {
  const f = await piFixture(quick); const file = f.sessionPath("truncated"); const server = await startServer(f);
  try {
    const content = JSON.stringify({ type: "session", id: "source", version: 3, cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "保留", timestamp: Date.now() } }) + '\n{"type":"message","id":"broken';
    await writeFile(file, content); const hash = createHash("sha256").update(content).digest("hex");
    const token = await pair(server); const readonly = await open(server, token, f, { sessionFile: file }); assert.equal(readonly.entries.length, 1); assert.equal(readonly.diagnostics.length, 1);
    const forked = await open(server, token, f, { sessionFile: file, fork: true }); assert.notEqual(forked.sessionFile, file);
    const parsed = await readSession(forked.sessionFile); assert.equal(path.resolve(parsed.header.parentSession), path.resolve(file));
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash);
    const result = await control(server, token, forked, { type: "prompt", message: "分叉继续" }); assert.equal(result.code, 200, JSON.stringify(result));
    await until(async () => (await snapshot(server, token, result.value.snapshot.ref.id)).status === "idle");
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash);
  } finally { await server.close(); await f.cleanup(); }
});

test("尾行截断的旧文件直接托管：保留完整条目，发送 settled 后原文件可重新解析", { timeout: 60000 }, async () => {
  const f = await piFixture(quick); const file = f.sessionPath("truncated-recovery"); const server = await startServer(f);
  let unsubscribe;
  try {
    const header = { type: "session", id: randomUUID(), version: 3, cwd: f.cwd, timestamp: new Date().toISOString() };
    const preserved = { type: "message", id: "preserved", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "原完整条目", timestamp: Date.now() } };
    const incomplete = '{"type":"message","id":"broken';
    await writeFile(file, JSON.stringify(header) + "\n" + JSON.stringify(preserved) + "\n" + incomplete);
    const old = new Date(Date.now() - 120000); await utimes(file, old, old);
    assert.ok(Date.now() - (await stat(file)).mtimeMs > 60000);
    const token = await pair(server); const opened = await open(server, token, f, { sessionFile: file });
    assert.equal(path.resolve(opened.sessionFile), path.resolve(file)); assert.equal(opened.warning, undefined);
    assert.deepEqual(opened.entries, [preserved]); assert.equal(opened.diagnostics.length, 1);
    const events = []; unsubscribe = server.sessions.subscribe(opened.ref.id, opened.cursor, event => events.push(event.event));
    const result = await control(server, token, opened, { type: "prompt", message: "原文件继续" });
    assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.ref.id, header.id);
    assert.equal(path.resolve(result.value.snapshot.sessionFile), path.resolve(file));
    const settled = await until(async () => {
      const state = await snapshot(server, token, opened.ref.id);
      return events.some(event => event.type === "agent_settled") && state.status === "idle" && state.inFlight.phase === "idle" && JSON.stringify(state.entries).includes("恢复完成") && state;
    }, 20000);
    assert.deepEqual(settled.entries.find(entry => entry.id === preserved.id), preserved);
    const parsed = await readSession(file);
    assert.deepEqual(parsed.diagnostics, opened.diagnostics); assert.deepEqual(parsed.header, header);
    assert.deepEqual(parsed.entries.find(entry => entry.id === preserved.id), preserved);
    assert.equal(parsed.entries.filter(entry => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("原文件继续")).length, 1);
    assert.equal(parsed.entries.filter(entry => entry.type === "message" && entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("恢复完成")).length, 1);
    assert.deepEqual(parsed.entries, settled.entries); assert.equal(parsed.leafId, settled.leafId);
    const lines = (await readFile(file, "utf8")).split("\n").filter(line => line.trim());
    assert.equal(lines[2], incomplete);
    for (const [index, line] of lines.entries()) if (index !== 2) assert.doesNotThrow(() => JSON.parse(line));
  } finally { unsubscribe?.(); await server.close(); await f.cleanup(); }
});

test("流式输出中服务端被强杀：重启先恢复旧身份，旧凭证和 ticket 无效，重新配对与磁盘一致", { timeout: 90000 }, async () => {
  const f = await piFixture(hung); let host; let server;
  try {
    host = fork(new URL("./fixtures/server-host.mjs", import.meta.url), [], { env: { ...f.env, PANE_FIXTURE: JSON.stringify({ root: f.root, cwd: f.cwd, agentDir: f.agentDir, piPath: f.install.packageDir, providerPath, containment }) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let diagnostics = ""; host.stderr.on("data", c => diagnostics += c);
    const info = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("子服务端未就绪：" + diagnostics)), 20000); host.once("message", m => { clearTimeout(timer); resolve(m); }); host.once("error", reject); });
    const remote = { origin: info.origin, auth: { issuePairCode: () => info.code } }; const oldToken = await pair(remote);
    const id = await started(remote, oldToken, f); const before = await snapshot(remote, oldToken, id); const writer = await identity(f);
    const ticket = (await request(remote, oldToken, "/api/ws-ticket", {})).value.ticket;
    const exit = new Promise(resolve => host.once("exit", resolve)); host.kill("SIGKILL"); await exit;
    server = await startServer(f, { port: Number(new URL(info.origin).port) });
    assert.equal(await isSameProcess(writer), "gone"); assert.equal((await request(server, oldToken, "/api/sessions")).code, 401); assert.throws(() => server.auth.redeemTicket(ticket));
    const token = await pair(server); const opened = await open(server, token, f, { sessionFile: before.sessionFile });
    const parsed = await readSession(before.sessionFile); assert.deepEqual(opened.entries, parsed.entries); assert.equal(opened.leafId, parsed.leafId);
    await f.setScript(quick); const resumed = await control(server, token, opened, { type: "prompt", message: "重启后继续" }); assert.equal(resumed.code, 200, JSON.stringify(resumed));
  } finally { if (host?.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); if (server) await server.close(); await f.cleanup(); }
});
