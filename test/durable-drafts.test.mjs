// 清出的草稿在服务端落盘：服务端正常关停（Ctrl+C）时排队的草稿、停止或关闭的结果没有交到浏览器时，
// 草稿保存在数据目录的 drafts/ 下，服务端重启后仍可按会话 id 读取，浏览器确认取回后删除。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSameProcess } from "pi-hostkit";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { AssetStore } from "../packages/server/dist/assets.js";
import { DraftOutbox, SAVED_DRAFTS_RETENTION_MS } from "../packages/server/dist/draft-outbox.js";
import { piFixture, providerPath, until, isWin } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";

const uiExtension = fileURLToPath(new URL("./fixtures/web-ui.ts", import.meta.url));
const text = (value) => [{ type: "text", text: value }];
const sure = (nodes) => ({ nodes, uncertain: false });
const unsure = (nodes) => ({ nodes, uncertain: true });
const thumbnail = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

async function files(root) {
  const found = [];
  for (const directory of await readdir(root).catch(() => [])) for (const name of await readdir(path.join(root, directory))) found.push(path.join(root, directory, name));
  return found;
}

test("服务端草稿存储：按会话保存、读取、删除，跳过损坏或不属于该会话的文件，过期清理", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  let now = Date.parse("2026-11-25T00:00:00Z");
  const outbox = new DraftOutbox(path.join(f.root, "pane"), () => now);
  await outbox.save("会话/甲", { id: "空", reason: "shutdown", drafts: [] });
  assert.deepEqual(await files(outbox.root), [], "没有草稿时不写入");
  await outbox.save("会话/甲", { id: "r-2", reason: "stop", drafts: [sure(text("第二"))] });
  now += 1;
  await outbox.save("会话/甲", { id: "r-1", reason: "close", drafts: [{ nodes: text("第一"), uncertain: true }] });
  await outbox.save("会话/乙", { id: "r-2", reason: "shutdown", drafts: [sure(text("乙"))] });
  const saved = await files(outbox.root);
  assert.equal(saved.length, 3);
  for (const file of saved) {
    assert.match(path.basename(file), /^[a-f0-9]{64}\.json$/, "文件名使用哈希，不含会话 id 或 requestId 原文");
    if (!isWin) assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await outbox.list("会话/甲"), [
    { id: "r-2", reason: "stop", at: "2026-11-25T00:00:00.000Z", drafts: [sure(text("第二"))] },
    { id: "r-1", reason: "close", at: "2026-11-25T00:00:00.001Z", drafts: [{ nodes: text("第一"), uncertain: true }] },
  ], "按保存时间排序");
  assert.deepEqual((await outbox.list("会话/乙")).map((record) => record.id), ["r-2"], "同一 id 在不同会话中各自保存");
  assert.deepEqual(await outbox.list("会话/丙"), []);

  const directory = path.join(outbox.root, createHash("sha256").update("会话/甲").digest("hex"));
  await writeFile(path.join(directory, "坏.json"), "{坏");
  await writeFile(path.join(directory, "他.json"), JSON.stringify({ version: 1, sessionId: "其他", id: "x", reason: "stop", at: "2026-11-25T00:00:00Z", drafts: [] }));
  assert.deepEqual((await outbox.list("会话/甲")).map((record) => record.id), ["r-2", "r-1"], "损坏或不属于该会话的文件跳过");

  await outbox.remove("会话/甲", ["r-2", "不存在"]);
  assert.deepEqual((await outbox.list("会话/甲")).map((record) => record.id), ["r-1"]);
  await outbox.remove("会话/甲", ["r-1"]);
  assert.deepEqual(await outbox.list("会话/甲"), []);

  // 超过保留期限的记录与中断写入留下的临时文件由定期清理删除；期限内的保留。
  const [kept] = await files(outbox.root).then((list) => list.filter((file) => file.endsWith(".json") && !file.includes("坏") && !file.includes("他")));
  const temporary = kept + ".x.tmp"; await writeFile(temporary, "{}");
  const old = new Date(now - SAVED_DRAFTS_RETENTION_MS - 1000);
  await utimes(temporary, new Date(now - 3_700_000), new Date(now - 3_700_000));
  await outbox.sweep();
  assert.equal((await files(outbox.root)).includes(temporary), false, "超过 1 小时的临时文件删除");
  assert.deepEqual((await outbox.list("会话/乙")).map((record) => record.id), ["r-2"], "期限内的记录保留");
  for (const file of await files(outbox.root)) await utimes(file, old, old);
  await outbox.sweep();
  assert.deepEqual(await files(outbox.root), [], "超过 30 天的记录和空目录删除");
});

const quickHang = { fallback: { segments: [{ type: "hang" }] } };
async function ready(server, token, f) {
  const result = await control(server, token, await open(server, token, f), { type: "prompt", message: "/pane-web-ready" });
  assert.equal(result.code, 200, JSON.stringify(result)); return result.value.snapshot;
}
async function upload(server, token, i) {
  const form = new FormData();
  form.append("image", new Blob([png(i, 1, 1)], { type: "image/png" }), `queue-${i}.png`);
  form.append("thumb", new Blob([Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64")], { type: "image/webp" }), "thumb.webp");
  const response = await fetch(server.origin + "/api/assets", { method: "POST", headers: { Authorization: "Bearer " + token, "X-Request-Id": randomUUID() }, body: form });
  assert.equal(response.status, 200);
  return (await response.json()).assetId;
}
/** 开始一轮挂起的回复，排入一条带图片的 follow-up 和一条纯文字 steer。返回发送时的草稿，按 clear_queue 的顺序（steering 在前）。 */
async function queueDrafts(server, token, f, state) {
  const running = await control(server, token, state, { type: "prompt", message: "挂起的回合" });
  assert.equal(running.code, 200, JSON.stringify(running));
  await until(async () => (await readFile(f.env.FAKE_REQUEST_LOG, "utf8").catch(() => "")).includes('"kind":"hang"'));
  const assetId = await upload(server, token, 0);
  const image = [{ type: "text", text: "图片之前 " }, { type: "image", assetId }, { type: "text", text: " 图片之后" }];
  const plain = text("排队的纯文字");
  for (const [command, draft] of [["follow_up", image], ["steer", plain]]) {
    const queued = await control(server, token, await snapshot(server, token, state.ref.id), { type: command }, { draft });
    assert.equal(queued.code, 200, JSON.stringify(queued));
    assert.equal(queued.value.status, "accepted");
  }
  await until(async () => (await snapshot(server, token, state.ref.id)).inFlight.queue?.followUp?.length === 1);
  return [plain, image];
}
const requests = async (f) => (await readFile(f.env.FAKE_REQUEST_LOG, "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.kind === "request").length;

test("#10 服务端正常关停时清出排队的草稿（含图片）保存到数据目录，重启后按会话 id 读取，删除后不再返回", { timeout: 90_000 }, async (t) => {
  const f = await piFixture(quickHang); t.after(() => f.cleanup());
  let server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    let token = await pair(server); const state = await ready(server, token, f);
    const drafts = await queueDrafts(server, token, f, state);
    const before = await requests(f);
    await server.close();
    const outbox = new DraftOutbox(f.root + "/pane");
    const [record] = await outbox.list(state.ref.id);
    assert.equal(record.reason, "shutdown");
    assert.deepEqual(record.drafts, drafts.map(sure), "关停时按停止的语义清队列，保存原草稿（含图片节点），steering 在前");
    assert.equal(await requests(f), before, "关停时排队的消息不得发送");

    server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
    token = await pair(server);
    // 会话尚未在新实例中打开，按会话 id 仍可读取。
    const listed = await request(server, token, `/api/sessions/${encodeURIComponent(state.ref.id)}/drafts`);
    assert.equal(listed.code, 200, JSON.stringify(listed));
    assert.deepEqual(listed.value.records, [record]);
    assert.deepEqual((await request(server, token, `/api/sessions/other/drafts`)).value.records, [], "不在其他会话中返回");
    const bad = await request(server, token, `/api/sessions/${encodeURIComponent(state.ref.id)}/drafts`, { requestId: randomUUID(), remove: [1] });
    assert.equal(bad.code, 400); assert.equal(bad.value.error, "invalidDraftIds");
    const removed = await request(server, token, `/api/sessions/${encodeURIComponent(state.ref.id)}/drafts`, { requestId: randomUUID(), remove: [record.id] });
    assert.deepEqual(removed, { code: 200, value: { status: "done" } });
    assert.deepEqual((await request(server, token, `/api/sessions/${encodeURIComponent(state.ref.id)}/drafts`)).value.records, []);
  } finally { await server.close(); }
});

for (const kind of ["stop", "close"]) {
  test(`#11 ${kind} 清出的草稿以 requestId 保存，同一请求续取得到原结果，服务端重启后幂等记录不在时仍可读取`, { timeout: 90_000 }, async (t) => {
    const f = await piFixture(quickHang); t.after(() => f.cleanup());
    let server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
    try {
      let token = await pair(server); const state = await ready(server, token, f);
      const drafts = await queueDrafts(server, token, f, state);
      const view = await snapshot(server, token, state.ref.id);
      const body = { requestId: randomUUID(), expectedEpoch: view.cursor.epoch, expectedRevision: view.controlRevision, command: { type: kind } };
      const route = `/api/sessions/${encodeURIComponent(state.ref.id)}`;
      const stopped = await request(server, token, route + "/control", body);
      assert.equal(stopped.code, 200, JSON.stringify(stopped));
      assert.deepEqual(stopped.value, { status: "done", clearedText: [drafts[0][0].text, stopped.value.clearedText[1]], clearedDrafts: drafts });
      const saved = (await request(server, token, route + "/drafts")).value.records;
      assert.deepEqual(saved.map(({ id, reason, drafts }) => ({ id, reason, drafts })), [{ id: body.requestId, reason: kind, drafts: drafts.map(sure) }],
        "只保存一条记录：关闭时写者停止流程再次清队列为空，不重复保存");
      assert.deepEqual((await request(server, token, route + "/control", body)).value, stopped.value, "同一 requestId 续取得到原结果");

      await server.close();
      server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
      token = await pair(server);
      await open(server, token, f, { sessionFile: view.sessionFile });
      const stale = await request(server, token, route + "/control", body);
      assert.equal(stale.code, 409); assert.equal(stale.value.error, "epochChanged", "重启后幂等记录不在，旧 epoch 被拒绝，不重新执行");
      const listed = (await request(server, token, route + "/drafts")).value.records;
      assert.deepEqual(listed.map(({ id, reason, drafts }) => ({ id, reason, drafts })), [{ id: body.requestId, reason: kind, drafts: drafts.map(sure) }],
        kind === "close" ? "关闭后写者已停止，关停时没有新的记录" : "服务端关停时写者已空闲，没有新的记录");
    } finally { await server.close(); }
  });
}

test("删除空的会话目录与保存同一会话的新记录并发时，保存不失败", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const outbox = new DraftOutbox(path.join(f.root, "pane"));
  // remove() 删除空目录可能落在 save() 建目录之后、写临时文件之前；反复并发，所有保存都须成功并可读取。
  for (let i = 0; i < 200; i++) {
    await Promise.all([outbox.save("会话", { id: `r-${i}`, reason: "stop", drafts: [sure(text(String(i)))] }), outbox.remove("会话", [`r-${i - 1}`]), outbox.sweep()]);
    assert.deepEqual((await outbox.list("会话")).map((record) => record.id), [`r-${i}`]);
  }
});

test("附件清理跳过仍被服务端暂存草稿引用的图片，30 天内放回时图片仍在；记录删除后按 7 天未使用的期限清理", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const home = path.join(f.root, "pane"); let now = Date.parse("2026-11-25T00:00:00Z");
  const assets = new AssetStore(home, undefined, () => now); const outbox = new DraftOutbox(home, () => now);
  const stored = (assetId) => existsSync(path.join(home, "assets", assetId.slice(7, 9), assetId.slice(7) + ".png"));
  const referenced = assets.upload(Buffer.from(png(0, 2, 2)), "image/png", thumbnail).assetId;
  const loose = assets.upload(Buffer.from(png(0, 3, 3)), "image/png", thumbnail).assetId;
  await outbox.save("会话", { id: "s1", reason: "shutdown", drafts: [sure([{ type: "text", text: "图 " }, { type: "image", assetId: referenced }])] });
  assert.deepEqual([...await outbox.assets()], [referenced]);
  now += 29 * 86_400_000;
  assets.sweep(await outbox.assets());
  assert.equal(stored(loose), false, "未被引用的图片 7 天未使用后清理");
  assert.equal(stored(referenced), true, "仍被草稿记录引用的图片保留");
  // 放回时浏览器 touch 图片：图片仍在，放回的草稿可以原样发送。
  assert.deepEqual(assets.touch([referenced]), { missing: [] });
  now += 8 * 86_400_000;
  await outbox.remove("会话", ["s1"]);
  assets.sweep(await outbox.assets());
  assert.equal(stored(referenced), false, "记录删除后按普通期限清理");
});

test("服务端草稿接口：未鉴权 401，Host 或 Origin 不符 403，同一 requestId 配不同的删除内容 409", { timeout: 30_000 }, async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const server = await startServer(f);
  try {
    const token = await pair(server); const route = `/api/sessions/${encodeURIComponent("会话")}/drafts`;
    assert.equal((await request(server, "bad-token", route)).code, 401);
    assert.equal((await request(server, "bad-token", route, { requestId: randomUUID(), remove: ["a"] })).code, 401);
    const raw = (headers) => new Promise((resolve, reject) => {
      const req = http.request(server.origin + route, { headers: { Authorization: "Bearer " + token, ...headers } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      req.on("error", reject); req.end();
    });
    assert.equal(await raw({}), 200);
    assert.equal(await raw({ Host: "evil.test:" + new URL(server.origin).port }), 403);
    assert.equal(await raw({ Origin: "http://evil.test" }), 403);
    const requestId = randomUUID();
    assert.equal((await request(server, token, route, { requestId, remove: ["a"] })).code, 200);
    const conflict = await request(server, token, route, { requestId, remove: ["b"] });
    assert.equal(conflict.code, 409); assert.equal(conflict.value.error, "idempotencyConflict");
  } finally { await server.close(); }
});

/** 让 pi 照常处理 clear_queue，但调用方收不到响应（等同超时后迟到）。 */
function lateClearQueue(handle) {
  const rpc = handle.rpc.bind(handle);
  handle.rpc = (command, options) => command.type === "clear_queue"
    ? rpc(command, options).then(() => { throw new Error("模拟 clear_queue 超时：pi 已清空队列，响应迟到"); })
    : rpc(command, options);
}

test("服务端关停时 clear_queue 结果未知（超时后 pi 仍清空队列）：按队列镜像把全部草稿保存为归属不明", { timeout: 90_000 }, async (t) => {
  const f = await piFixture(quickHang); t.after(() => f.cleanup());
  const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  let state; let drafts;
  try {
    const token = await pair(server); state = await ready(server, token, f);
    drafts = await queueDrafts(server, token, f, state);
    lateClearQueue(server.sessions.records.get(state.ref.id).handle);
  } finally { await server.close(); }
  const records = await new DraftOutbox(path.join(f.root, "pane")).list(state.ref.id);
  assert.deepEqual(records.map(({ reason, drafts }) => ({ reason, drafts })), [{ reason: "shutdown", drafts: drafts.map(unsure) }]);
});

test("停止时 clear_queue 结果未知：结果把全部排队草稿作为归属不明交出，以 requestId 只保存一条", { timeout: 90_000 }, async (t) => {
  const f = await piFixture(quickHang); t.after(() => f.cleanup());
  const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    const token = await pair(server); const state = await ready(server, token, f);
    const drafts = await queueDrafts(server, token, f, state);
    lateClearQueue(server.sessions.records.get(state.ref.id).handle);
    const view = await snapshot(server, token, state.ref.id);
    const body = { requestId: randomUUID(), expectedEpoch: view.cursor.epoch, expectedRevision: view.controlRevision, command: { type: "stop" } };
    const route = `/api/sessions/${encodeURIComponent(state.ref.id)}`;
    const stopped = await request(server, token, route + "/control", body);
    assert.deepEqual(stopped, { code: 200, value: { status: "done", clearedText: [], clearedDrafts: [], uncertainDrafts: drafts } });
    await until(async () => !server.sessions.records.get(state.ref.id).handle);
    const saved = (await request(server, token, route + "/drafts")).value.records;
    assert.deepEqual(saved.map(({ id, reason, drafts }) => ({ id, reason, drafts })), [{ id: body.requestId, reason: "stop", drafts: drafts.map(unsure) }],
      "写者停止流程不按同一镜像再保存一份");
  } finally { await server.close(); }
});

test("保存清出草稿的文件 I/O 挂起时，关停最多等待 2 秒后继续停止 pi 进程", { timeout: 90_000 }, async (t) => {
  const f = await piFixture(quickHang); t.after(() => f.cleanup());
  const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  let identity; let started;
  try {
    const token = await pair(server); const state = await ready(server, token, f);
    await queueDrafts(server, token, f, state);
    identity = server.sessions.records.get(state.ref.id).handle.identity;
    server.sessions.outbox.save = () => new Promise(() => {});
    started = Date.now();
  } finally { await server.close(); }
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2000 && elapsed < 8000, `关停用时 ${elapsed} 毫秒`);
  assert.equal(await isSameProcess(identity), "gone");
});

test("CLI 收到 SIGINT 后关闭服务端并退出进程", { timeout: 60_000, skip: isWin && "Windows 上 SIGINT 无法发给子进程的处理函数" }, async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const home = path.join(f.root, "cli-home"); await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.json"), JSON.stringify({ port: 0 }));
  const cli = fileURLToPath(new URL("../packages/server/dist/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli], { env: { ...process.env, PI_PANE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  await until(() => output.includes("配对地址"), 20_000);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const started = Date.now(); child.kill("SIGINT");
  assert.deepEqual(await exited, { code: 0, signal: null }, output);
  assert.ok(Date.now() - started < 15_000);
});
