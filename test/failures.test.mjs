import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
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
    await f.setScript(quick); const resumed = await control(server, token, interrupted, { type: "prompt", message: "继续" });
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

test("两个标签页的发送、停止和模型切换均检查 revision，重复 requestId 只执行一次", { timeout: 60000 }, async () => {
  const f = await piFixture(hung); const server = await startServer(f);
  try {
    const token = await pair(server); const second = await pair(server); const id = await started(server, token, f);
    let state = await snapshot(server, token, id);
    let results = await Promise.all([control(server, token, state, { type: "steer", message: "第一方" }), control(server, second, state, { type: "follow_up", message: "第二方" })]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409]); assert.equal(results.find(r => r.code === 409).value.error, "revisionChanged");
    state = await snapshot(server, token, id);
    results = await Promise.all([control(server, token, state, { type: "follow_up", message: "发送方" }), control(server, second, state, { type: "stop" })]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409]);
    state = await snapshot(server, token, id);
    results = await Promise.all([control(server, token, state, { type: "set_model", provider: "p0-fake", modelId: "scripted" }), control(server, second, state, { type: "follow_up", message: "模型竞态" })]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409]);
    state = await snapshot(server, token, id); const requestId = randomUUID();
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
