// 清出的草稿在服务端落盘：停止、关闭、服务端正常关停（Ctrl+C）时排队的草稿保存在数据目录的 drafts/ 下，
// 服务端重启后仍可按会话 id 读取；浏览器领取时原子地删除记录并取得内容，只有第一个领取者拿到。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSameProcess } from "pi-hostkit";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { AssetStore } from "../packages/server/dist/assets.js";
import { DraftOutbox, SAVED_DRAFTS_RETENTION_MS } from "../packages/server/dist/draft-outbox.js";
import { piFixture, providerPath, until, isWin } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";

const uiExtension = fileURLToPath(new URL("./fixtures/web-ui.ts", import.meta.url));
const text = (value) => [{ type: "text", text: value }];
const sure = (nodes) => ({ nodes, uncertain: false });
const unsure = (nodes) => ({ nodes, uncertain: true });
const thumbnail = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

async function files(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) for (const name of await readdir(path.join(root, entry.name))) found.push(path.join(root, entry.name, name));
  }
  return found;
}

test("服务端草稿存储：按会话保存、读取、领取，跳过损坏或不属于该会话的文件和非目录项，过期清理", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  let now = Date.parse("2026-11-25T00:00:00Z");
  const outbox = new DraftOutbox(path.join(f.root, "pane"), () => now);
  const changes = []; const off = outbox.onChange((sessionId) => changes.push(sessionId));
  await outbox.save("会话/甲", { id: "空", reason: "shutdown", drafts: [] });
  assert.deepEqual(await files(outbox.root), [], "没有草稿时不写入");
  await outbox.save("会话/甲", { id: "r-2", reason: "stop", drafts: [sure(text("第二"))] });
  now += 1;
  await outbox.save("会话/甲", { id: "r-1", reason: "close", drafts: [{ nodes: text("第一"), uncertain: true }] });
  await outbox.save("会话/乙", { id: "r-2", reason: "shutdown", drafts: [sure(text("乙"))] });
  assert.deepEqual(changes, ["会话/甲", "会话/甲", "会话/乙"], "保存后通知所属会话");
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
  await mkdir(path.join(directory, "目录.json"));
  // 系统生成的非目录项（如 macOS 的 .DS_Store）不影响读取、引用收集和清理。
  await writeFile(path.join(outbox.root, ".DS_Store"), "x");
  assert.deepEqual((await outbox.list("会话/甲")).map((record) => record.id), ["r-2", "r-1"], "损坏、不属于该会话的文件和目录跳过");
  assert.deepEqual([...await outbox.assets()], []);

  changes.length = 0;
  assert.deepEqual(await outbox.claim("会话/甲", "r-2"), { id: "r-2", reason: "stop", at: "2026-11-25T00:00:00.000Z", drafts: [sure(text("第二"))] }, "领取返回记录内容");
  assert.equal(await outbox.claim("会话/甲", "r-2"), undefined, "已领取的记录不能再领取");
  assert.equal(await outbox.claim("会话/甲", "不存在"), undefined);
  assert.equal(await outbox.claim("会话/丙", "r-1"), undefined, "不能从其他会话领取");
  assert.deepEqual(changes, ["会话/甲"], "领取后通知，没有领到时不通知");
  assert.deepEqual((await outbox.list("会话/甲")).map((record) => record.id), ["r-1"]);
  off();

  // 超过保留期限的记录、中断写入留下的临时文件、中断领取留下的领取中文件由定期清理删除；期限内的保留。
  const [kept] = (await files(outbox.root)).filter((file) => /[a-f0-9]{64}\.json$/.test(file) && file.includes(path.basename(directory)));
  const temporary = kept + ".x.tmp"; await writeFile(temporary, "{}");
  await utimes(temporary, new Date(now - 3_700_000), new Date(now - 3_700_000));
  const staleClaim = `${kept}.${now - 3_700_000}-0f.claiming`; await writeFile(staleClaim, "{}");
  const freshClaim = `${kept}.${now - 1_000}-1f.claiming`; await writeFile(freshClaim, "{}");
  // 改名保留原文件的修改时间：领取中文件按名称中的领取时间计算，不按修改时间。
  await utimes(freshClaim, new Date(now - SAVED_DRAFTS_RETENTION_MS * 2), new Date(now - SAVED_DRAFTS_RETENTION_MS * 2));
  await outbox.sweep();
  const after = await files(outbox.root);
  assert.equal(after.includes(temporary), false, "超过 1 小时的临时文件删除");
  assert.equal(after.includes(staleClaim), false, "领取时间超过 1 小时的领取中文件删除");
  assert.equal(after.includes(freshClaim), true, "刚开始领取的文件保留");
  assert.deepEqual((await outbox.list("会话/乙")).map((record) => record.id), ["r-2"], "期限内的记录保留");
  assert.equal(existsSync(path.join(outbox.root, ".DS_Store")), true, "非目录项不删除");
  now += 3_700_000;
  const old = new Date(now - SAVED_DRAFTS_RETENTION_MS - 1000);
  for (const file of await files(outbox.root)) if (!file.endsWith("目录.json")) await utimes(file, old, old);
  await rm(path.join(directory, "目录.json"), { recursive: true });
  await outbox.sweep();
  assert.deepEqual(await files(outbox.root), [], "超过 30 天的记录和空目录删除");
});

test("并发领取同一条记录只有一个拿到内容", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const outbox = new DraftOutbox(path.join(f.root, "pane"));
  for (let round = 0; round < 20; round++) {
    await outbox.save("会话", { id: `r-${round}`, reason: "shutdown", drafts: [sure(text(String(round)))] });
    const results = await Promise.all(Array.from({ length: 8 }, () => outbox.claim("会话", `r-${round}`)));
    assert.deepEqual(results.filter(Boolean).map((record) => record.drafts), [[sure(text(String(round)))]], `第 ${round} 轮`);
  }
  assert.deepEqual(await outbox.list("会话"), []);
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

const claimRoute = (id, recordId) => `/api/sessions/${encodeURIComponent(id)}/drafts/${encodeURIComponent(recordId)}/claim`;

test("#10 服务端正常关停时清出排队的草稿（含图片）保存到数据目录，重启后按会话 id 读取，领取后删除，订阅者收到变更通知", { timeout: 90_000 }, async (t) => {
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
    assert.deepEqual((await request(server, token, claimRoute("other", record.id), { requestId: randomUUID() })).value, { status: "gone" }, "不能从其他会话领取");

    // 打开并订阅该会话的连接在记录领取时收到 drafts_changed。
    const view = await open(server, token, f, { sessionFile: state.sessionFile });
    const socket = await connect(server, token); t.after(() => socket.close());
    socket.subscribe(view);
    // 同一连接上的消息按序处理：收到 pong 时订阅已生效。
    socket.ws.send(JSON.stringify({ type: "ping" }));
    await until(() => socket.messages.some((message) => message.type === "pong"));
    const requestId = randomUUID();
    const claimed = await request(server, token, claimRoute(state.ref.id, record.id), { requestId });
    assert.deepEqual(claimed, { code: 200, value: { status: "claimed", record } });
    await until(() => socket.messages.some((message) => message.type === "drafts_changed" && message.ref.id === state.ref.id));
    assert.deepEqual((await request(server, token, `/api/sessions/${encodeURIComponent(state.ref.id)}/drafts`)).value.records, []);
    assert.deepEqual((await request(server, token, claimRoute(state.ref.id, record.id), { requestId: randomUUID() })).value, { status: "gone" }, "其他请求领不到");
    assert.deepEqual(await request(server, token, claimRoute(state.ref.id, record.id), { requestId }), claimed, "同一 requestId 重试得到同一份内容");
    const bad = await request(server, token, claimRoute(state.ref.id, record.id), { requestId: 1 });
    assert.equal(bad.code, 400); assert.equal(bad.value.error, "invalidRequestId");
  } finally { await server.close(); }
});

for (const kind of ["stop", "close"]) {
  test(`#11 ${kind} 清出的草稿以 requestId 保存，结果带 draftsRecord，服务端重启后幂等记录不在时仍可读取和领取`, { timeout: 90_000 }, async (t) => {
    const f = await piFixture(quickHang); t.after(() => f.cleanup());
    let server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
    try {
      let token = await pair(server); const state = await ready(server, token, f);
      const drafts = await queueDrafts(server, token, f, state);
      const view = await snapshot(server, token, state.ref.id);
      const socket = await connect(server, token); t.after(() => socket.close());
      socket.subscribe(view);
      socket.ws.send(JSON.stringify({ type: "ping" }));
      await until(() => socket.messages.some((message) => message.type === "pong"));
      const body = { requestId: randomUUID(), expectedEpoch: view.cursor.epoch, expectedRevision: view.controlRevision, command: { type: kind } };
      const route = `/api/sessions/${encodeURIComponent(state.ref.id)}`;
      const stopped = await request(server, token, route + "/control", body);
      assert.equal(stopped.code, 200, JSON.stringify(stopped));
      assert.deepEqual(stopped.value, { status: "done", clearedText: [drafts[0][0].text, stopped.value.clearedText[1]], clearedDrafts: drafts, draftsRecord: body.requestId });
      assert.ok(socket.messages.some((message) => message.type === "drafts_changed" && message.ref.id === state.ref.id), "返回结果之前已保存并通知");
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
      const claimed = await request(server, token, claimRoute(state.ref.id, body.requestId), { requestId: randomUUID() });
      assert.equal(claimed.value.status, "claimed"); assert.deepEqual(claimed.value.record.drafts, drafts.map(sure));
    } finally { await server.close(); }
  });
}

test("清理删除空的会话目录、领取与保存同一会话的新记录并发时，保存不失败", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const outbox = new DraftOutbox(path.join(f.root, "pane"));
  // 清理删除空目录可能落在 save() 建目录之后、写临时文件之前；反复并发，所有保存都须成功并可读取。
  for (let i = 0; i < 200; i++) {
    const [, claimed] = await Promise.all([outbox.save("会话", { id: `r-${i}`, reason: "stop", drafts: [sure(text(String(i)))] }), outbox.claim("会话", `r-${i - 1}`), outbox.sweep()]);
    if (i) assert.deepEqual(claimed?.drafts, [sure(text(String(i - 1)))]);
    assert.deepEqual((await outbox.list("会话")).map((record) => record.id), [`r-${i}`]);
  }
});

test("附件清理跳过仍被草稿记录或领取中文件引用的图片，30 天内领取时图片仍在；领取时刷新使用时间，之后按 7 天未使用的期限清理", async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const home = path.join(f.root, "pane"); let now = Date.parse("2026-11-25T00:00:00Z");
  const assets = new AssetStore(home, undefined, () => now); const outbox = new DraftOutbox(home, () => now);
  const stored = (assetId) => existsSync(path.join(home, "assets", assetId.slice(7, 9), assetId.slice(7) + ".png"));
  const referenced = assets.upload(Buffer.from(png(0, 2, 2)), "image/png", thumbnail).assetId;
  const claiming = assets.upload(Buffer.from(png(0, 4, 4)), "image/png", thumbnail).assetId;
  const loose = assets.upload(Buffer.from(png(0, 3, 3)), "image/png", thumbnail).assetId;
  await outbox.save("会话", { id: "s1", reason: "shutdown", drafts: [sure([{ type: "text", text: "图 " }, { type: "image", assetId: referenced }])] });
  // 中断的领取留下的领取中文件同样算作引用，直到清理删除它。
  await outbox.save("会话", { id: "s2", reason: "shutdown", drafts: [sure([{ type: "image", assetId: claiming }])] });
  const [s2] = (await files(outbox.root)).filter((file) => file.includes(createHash("sha256").update("s2").digest("hex")));
  await writeFile(`${s2}.${now + 29 * 86_400_000}-0f.claiming`, await readFile(s2)); await rm(s2);
  assert.deepEqual(new Set(await outbox.assets()), new Set([referenced, claiming]));
  now += 29 * 86_400_000;
  assets.sweep(await outbox.assets());
  assert.equal(stored(loose), false, "未被引用的图片 7 天未使用后清理");
  assert.equal(stored(referenced), true, "仍被草稿记录引用的图片保留");
  assert.equal(stored(claiming), true, "仍被领取中文件引用的图片保留");
  // 领取时刷新使用时间：领取后 6 天未使用仍在，8 天后按普通期限清理。不依赖浏览器另行 touch。
  const touched = [];
  assert.equal((await outbox.claim("会话", "s1", (ids) => { touched.push(...ids); assets.touch(ids); })).id, "s1");
  assert.deepEqual(touched, [referenced]);
  now += 6 * 86_400_000;
  assets.sweep(await outbox.assets());
  assert.equal(stored(referenced), true, "领取后 7 天内保留");
  now += 2 * 86_400_000;
  assets.sweep(await outbox.assets());
  assert.equal(stored(referenced), false, "领取后 7 天未使用即清理");
});

test("服务端草稿接口：未鉴权 401，Host 或 Origin 不符 403，同一 requestId 领取不同记录 409", { timeout: 30_000 }, async (t) => {
  const f = await piFixture(); t.after(() => f.cleanup());
  const server = await startServer(f);
  try {
    const token = await pair(server); const route = `/api/sessions/${encodeURIComponent("会话")}/drafts`;
    assert.equal((await request(server, "bad-token", route)).code, 401);
    assert.equal((await request(server, "bad-token", claimRoute("会话", "a"), { requestId: randomUUID() })).code, 401);
    const raw = (headers, target = route, method = "GET") => new Promise((resolve, reject) => {
      const req = http.request(server.origin + target, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...headers } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      req.on("error", reject); req.end(method === "POST" ? JSON.stringify({ requestId: randomUUID() }) : undefined);
    });
    assert.equal(await raw({}), 200);
    assert.equal(await raw({ Host: "evil.test:" + new URL(server.origin).port }), 403);
    assert.equal(await raw({ Origin: "http://evil.test" }), 403);
    assert.equal(await raw({}, claimRoute("会话", "a"), "POST"), 200);
    assert.equal(await raw({ Origin: "http://evil.test" }, claimRoute("会话", "a"), "POST"), 403);
    const requestId = randomUUID();
    assert.deepEqual(await request(server, token, claimRoute("会话", "a"), { requestId }), { code: 200, value: { status: "gone" } });
    const conflict = await request(server, token, claimRoute("会话", "b"), { requestId });
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

/** 第一次 clear_queue 没有到达 pi（传输失败，队列仍在），之后的 clear_queue 照常处理。 */
function failFirstClearQueue(handle) {
  const rpc = handle.rpc.bind(handle); let failed = false;
  handle.rpc = (command, options) => {
    if (command.type !== "clear_queue" || failed) return rpc(command, options);
    failed = true; return Promise.reject(new Error("模拟 clear_queue 传输失败"));
  };
}

test("停止时 clear_queue 结果未知：结果把全部排队草稿作为归属不明交出，以 requestId 只保存一条；写者停止流程再次清出的内容不另存", { timeout: 90_000 }, async (t) => {
  const f = await piFixture(quickHang); t.after(() => f.cleanup());
  const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    const token = await pair(server); const state = await ready(server, token, f);
    const drafts = await queueDrafts(server, token, f, state);
    const handle = server.sessions.records.get(state.ref.id).handle;
    failFirstClearQueue(handle);
    const cleared = []; const rpc = handle.rpc;
    handle.rpc = async (command, options) => { const response = await rpc(command, options); if (command.type === "clear_queue") cleared.push(response.data); return response; };
    const view = await snapshot(server, token, state.ref.id);
    const body = { requestId: randomUUID(), expectedEpoch: view.cursor.epoch, expectedRevision: view.controlRevision, command: { type: "stop" } };
    const route = `/api/sessions/${encodeURIComponent(state.ref.id)}`;
    const stopped = await request(server, token, route + "/control", body);
    assert.deepEqual(stopped, { code: 200, value: { status: "done", clearedText: [], clearedDrafts: [], uncertainDrafts: drafts, draftsRecord: body.requestId } });
    await until(async () => !server.sessions.records.get(state.ref.id).handle);
    assert.equal(cleared.length, 1); assert.equal(cleared[0].steering.length + cleared[0].followUp.length, 2, "写者停止流程的 clear_queue 清出了仍在 pi 队列中的两条");
    const saved = (await request(server, token, route + "/drafts")).value.records;
    assert.deepEqual(saved.map(({ id, reason, drafts }) => ({ id, reason, drafts })), [{ id: body.requestId, reason: "stop", drafts: drafts.map(unsure) }],
      "只有停止请求的一条记录，不出现含编码标记的第二份");
  } finally { await server.close(); }
});

test("保存清出草稿挂起时，停止约 2 秒后返回、结果不带 draftsRecord（浏览器直接放回结果中的草稿），同一会话的读取和领取不受拖延", { timeout: 90_000 }, async (t) => {
  const f = await piFixture(quickHang); t.after(() => f.cleanup());
  const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    const token = await pair(server); const state = await ready(server, token, f);
    const drafts = await queueDrafts(server, token, f, state);
    const outbox = server.sessions.outbox;
    await outbox.save(state.ref.id, { id: "已有", reason: "exit", drafts: [sure(text("已有"))] });
    outbox.save = () => new Promise(() => {});
    const view = await snapshot(server, token, state.ref.id);
    const route = `/api/sessions/${encodeURIComponent(state.ref.id)}`;
    const started = Date.now();
    const stopped = await request(server, token, route + "/control", { requestId: randomUUID(), expectedEpoch: view.cursor.epoch, expectedRevision: view.controlRevision, command: { type: "stop" } });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2000 && elapsed < 8000, `停止用时 ${elapsed} 毫秒`);
    assert.equal(stopped.value.status, "done"); assert.equal(stopped.value.draftsRecord, undefined);
    assert.deepEqual(stopped.value.clearedDrafts, drafts);
    // 挂起的保存仍未结束：读取和领取不排在它之后。
    const quick = Date.now();
    assert.deepEqual((await request(server, token, route + "/drafts")).value.records.map((record) => record.id), ["已有"]);
    assert.equal((await request(server, token, claimRoute(state.ref.id, "已有"), { requestId: randomUUID() })).value.status, "claimed");
    assert.ok(Date.now() - quick < 1000);
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
