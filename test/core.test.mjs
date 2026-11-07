import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_PROTOCOL, negotiateProtocol } from "../packages/plugin-api/dist/index.js";
import { SessionModel } from "../packages/server/dist/model.js";
import { RequestLedger, ControlQueue } from "../packages/server/dist/control.js";
import { parseSession, readSession, branch } from "../packages/server/dist/store.js";
import { AssetStore, hashId, imageInfo, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES, MAX_MESSAGE_IMAGE_BYTES } from "../packages/server/dist/assets.js";
import { restoreImages } from "../packages/bridge-extension/dist/images.js";
import { png, image } from "../experiments/p0/b-bridge/images.mjs";

const DAY = 86400000;
const thumb = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const code = expected => error => error?.code === expected;
const entry = (id, parentId = null, message = { role: "user", content: id }) => ({ type: "message", id, parentId, message });
async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "pane-core-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const assets = new AssetStore(home, options.maxCacheBytes, options.now);
  return { home, assets, model: new SessionModel({ source: "pane", id: "unit-session" }, assets, options.bufferSize, options.maxBufferBytes) };
}
function update(model, type, contentIndex, fields = {}) {
  model.apply({ type: "message_update", assistantMessageEvent: { type, contentIndex, ...fields } });
}
function user(text, images = [image()]) {
  return { role: "user", content: [{ type: "text", text }, ...images] };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("pane 协商选择交集最高版本并拒绝不兼容范围", () => {
  assert.equal(PANE_PROTOCOL, 1);
  assert.equal(negotiateProtocol([1, 1]), 1);
  assert.equal(negotiateProtocol([1, 9]), 1);
  assert.equal(negotiateProtocol([2, 5], [1, 3]), 3);
  assert.equal(negotiateProtocol([3, 3], [3, 8]), 3);
  for (const range of [[], [2], [1, 1, 1], null, "1,1", {}, new Array(2), [0, 1], [2, 1], [-1, 4], [1.5, 2], [1, Infinity], [NaN, 1], [1, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => negotiateProtocol(range), /范围无效/);
  }
  for (const range of [[], [1], [1, 1, 2], [1, NaN], [0, 1]]) assert.throws(() => negotiateProtocol([1, 1], range), /范围无效/);
  assert.throws(() => negotiateProtocol([2, 3]), /不兼容/);
  assert.throws(() => negotiateProtocol([1, 2], [3, 5]), /不兼容/);
});

test("SessionModel 同步快照切点重放、实时订阅及取消", async t => {
  const { model } = await fixture(t);
  model.reset([entry("a")], "a");
  const snapshot = model.snapshot();
  assert.equal(typeof snapshot.then, "undefined");
  model.apply({ type: "queue_update", steering: ["one"], followUp: [] });
  const received = [];
  const stop = model.subscribe(snapshot.cursor, event => received.push(event));
  assert.equal(received.length, 1);
  assert.equal(received[0].cursor.seq, snapshot.cursor.seq + 1);
  model.emit({ type: "after" });
  assert.deepEqual(received.map(e => e.event.type), ["queue_update", "after"]);
  assert.deepEqual(received.map(e => e.cursor.seq), [snapshot.cursor.seq + 1, snapshot.cursor.seq + 2]);
  snapshot.entries[0].message.content = "mutated";
  snapshot.inFlight.queue.steering.push("mutated");
  received[0].event.steering.push("listener mutation");
  assert.equal(model.snapshot().entries[0].message.content, "a");
  assert.deepEqual(model.snapshot().inFlight.queue.steering, ["one"]);
  stop(); model.emit({ type: "ignored" });
  assert.equal(received.length, 2);
});

test("SessionModel 缓冲淘汰边界、未来序号与非法游标触发 resync", async t => {
  const { model } = await fixture(t, { bufferSize: 2 });
  model.emit({ type: "one" }); model.emit({ type: "two" }); model.emit({ type: "three" });
  const received = [];
  const stop = model.subscribe({ epoch: model.epoch, seq: 1 }, e => received.push(e));
  assert.deepEqual(received.map(e => e.cursor.seq), [2, 3]); stop();
  for (const cursor of [{ epoch: model.epoch, seq: 0 }, { epoch: model.epoch, seq: 4 }, { epoch: model.epoch, seq: -1 }, { epoch: model.epoch, seq: 1.5 }, { epoch: "old", seq: 3 }]) {
    const events = []; const unsubscribe = model.subscribe(cursor, e => events.push(e));
    assert.equal(events.length, 1); assert.equal(events[0].event.type, "resync");
    assert.deepEqual(events[0].cursor, { epoch: model.epoch, seq: model.seq }); unsubscribe();
  }
});

test("SessionModel 字节缓冲淘汰与 epoch reset 通知", async t => {
  const { model } = await fixture(t, { maxBufferBytes: 1 });
  model.emit({ type: "one" }); const old = model.snapshot().cursor;
  model.emit({ type: "two" });
  const events = []; model.subscribe({ epoch: model.epoch, seq: 0 }, e => events.push(e));
  assert.equal(events[0].event.type, "resync");
  const live = []; const stop = model.subscribe(model.snapshot().cursor, e => live.push(e));
  model.reset([entry("new")], "new");
  assert.notEqual(model.epoch, old.epoch);
  assert.equal(model.seq, 1); assert.equal(live[0].event.type, "resync");
  const reconnect = []; model.subscribe(old, e => reconnect.push(e));
  assert.equal(reconnect[0].event.type, "resync"); stop();
});

test("SessionModel text/thinking/toolcall end 使用完整值替换增量", async t => {
  const { model } = await fixture(t);
  model.apply({ type: "message_start", message: { role: "assistant", timestamp: 123 } });
  for (const [index, type] of ["text", "thinking"].entries()) {
    update(model, `${type}_start`, index);
    update(model, `${type}_delta`, index, { delta: "part" });
    update(model, `${type}_delta`, index, { delta: "ial" });
    assert.equal(model.snapshot().inFlight.assistant.blocks[index].text, "partial");
    update(model, `${type}_end`, index, { content: "final" });
    assert.deepEqual(model.snapshot().inFlight.assistant.blocks[index], { type, contentIndex: index, text: "final", done: true });
  }
  update(model, "toolcall_start", 2);
  update(model, "toolcall_delta", 2, { delta: '{"old":' });
  update(model, "toolcall_end", 2, { toolCall: { id: "tool-1", name: "read", arguments: { path: "final" } } });
  assert.deepEqual(model.snapshot().inFlight.assistant.blocks[2], { type: "toolCall", contentIndex: 2, id: "tool-1", toolName: "read", argsText: '{"old":', args: { path: "final" }, done: true });
  update(model, "text_start", 0);
  assert.equal(model.snapshot().inFlight.assistant.blocks.length, 3);
  assert.equal(model.snapshot().inFlight.assistant.blocks[0].text, "");
});

test("SessionModel 工具、queue 与 completed 仅替换匹配的落盘消息", async t => {
  const { model } = await fixture(t);
  model.apply({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "a" } });
  model.apply({ type: "tool_execution_update", toolCallId: "t", partialResult: { content: [{ type: "text", text: "part" }] } });
  model.apply({ type: "queue_update", steering: ["steer"], followUp: ["later"] });
  const state = model.snapshot().inFlight;
  assert.equal(state.tools[0].toolCallId, "t"); assert.equal(state.tools[0].partialResult.content[0].text, "part");
  assert.deepEqual(state.queue, { steering: ["steer"], followUp: ["later"] });
  model.apply({ type: "tool_execution_end", toolCallId: "t" });
  assert.deepEqual(model.snapshot().inFlight.tools, []);
  const first = { role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 1 };
  const second = { ...first, content: [{ type: "text", text: "second" }], timestamp: 2 };
  model.apply({ type: "message_end", message: first }); model.apply({ type: "message_end", message: second });
  assert.deepEqual(model.snapshot().inFlight.completed, [first, second]);
  model.append([entry("a", null, first)], "a");
  assert.deepEqual(model.snapshot().inFlight.completed, [second]);
  model.append([entry("a", null, first), entry("b", "a", second)], "b");
  assert.deepEqual(model.snapshot().inFlight.completed, []);
  assert.deepEqual(model.snapshot().entries.map(e => e.id), ["a", "b"]);
});

test("SessionModel 历史页只投影活动分支，切换分支更换 epoch", async t => {
  const { model } = await fixture(t);
  const entries = [entry("root"), entry("a", "root"), entry("other", "root"), entry("b", "a"), entry("c", "b")];
  model.reset(entries, "c");
  const snapshot = model.snapshot(2);
  assert.deepEqual(snapshot.entries.map(e => e.id), ["b", "c"]); assert.equal(snapshot.historyBefore, "b");
  const page = model.history("b", 1);
  assert.deepEqual(page.entries.map(e => e.id), ["a"]); assert.equal(page.historyBefore, "a");
  assert.deepEqual(model.history("a", 10).entries.map(e => e.id), ["root"]);
  assert.equal(model.history("a", 10).historyBefore, null);
  assert.throws(() => model.history("other"), code("historyChanged"));
  const previous = model.epoch;
  model.append([entry("d", "other")], "d");
  assert.notEqual(model.epoch, previous);
  assert.deepEqual(model.snapshot().entries.map(e => e.id), ["root", "other", "d"]);
  assert.throws(() => branch([entry("x", "y"), entry("y", "x")], "x"), code("sessionCycle"));
});

test("SessionModel interrupt 保留 partial，reset 按参数保留或清空", async t => {
  const { model } = await fixture(t);
  model.apply({ type: "agent_start" }); update(model, "text_start", 0); update(model, "text_delta", 0, { delta: "unfinished" });
  model.interrupt("run-1", "transport lost");
  const snapshot = model.snapshot();
  assert.equal(snapshot.status, "interrupted"); assert.equal(snapshot.readonly, true);
  assert.equal(snapshot.inFlight.assistant, undefined);
  assert.equal(snapshot.unfinishedPartials[0].runId, "run-1");
  assert.deepEqual(snapshot.unfinishedPartials[0].blocks, [{ type: "text", contentIndex: 0, text: "unfinished", done: false }]);
  model.reset([], null); assert.equal(model.snapshot().unfinishedPartials.length, 1);
  model.reset([], null, true); assert.equal(model.snapshot().unfinishedPartials, undefined);
});

test("RequestLedger pending 到 final，内容键顺序归一且返回隔离副本", async () => {
  const ledger = new RequestLedger(); const gate = deferred(); let calls = 0;
  const original = ledger.execute("id", { a: 1, b: 2 }, () => { calls++; return gate.promise; });
  assert.deepEqual(await ledger.execute("id", { b: 2, a: 1 }, () => assert.fail("duplicate action")), { status: "pending" });
  assert.throws(() => ledger.execute("id", { a: 2 }, async () => null), code("idempotencyConflict"));
  gate.resolve({ status: "accepted", items: [1] });
  const result = await original; result.items.push(2);
  const cached = await ledger.execute("id", { a: 1, b: 2 }, async () => null);
  assert.deepEqual(cached, { status: "accepted", items: [1] }); cached.items.push(3);
  assert.deepEqual(await ledger.execute("id", { a: 1, b: 2 }, async () => null), { status: "accepted", items: [1] });
  assert.equal(calls, 1);
  for (const id of ["", "a".repeat(257), null]) assert.throws(() => ledger.execute(id, {}, async () => null), code("invalidRequestId"));
});

test("RequestLedger 缓存失败，final 至少保留 24h，pending 不过期", async () => {
  let now = 10; const ledger = new RequestLedger(() => now); const failure = new Error("failed"); let calls = 0;
  await assert.rejects(ledger.execute("failed", {}, async () => { throw failure; }), e => e === failure);
  await assert.rejects(ledger.execute("failed", {}, async () => assert.fail("retry")), e => e === failure);
  await ledger.execute("final", {}, async () => ++calls);
  now += DAY;
  assert.equal(await ledger.execute("final", {}, async () => ++calls), 1);
  now++;
  assert.equal(await ledger.execute("final", {}, async () => ++calls), 2);
  const gate = deferred(); const pending = ledger.execute("long", {}, () => gate.promise);
  now += 2 * DAY;
  assert.deepEqual(await ledger.execute("long", {}, async () => assert.fail("pending expired")), { status: "pending" });
  gate.resolve("done"); assert.equal(await pending, "done");
});

test("RequestLedger 等待超时不结束操作，迟到结果覆盖 pending", async () => {
  const ledger = new RequestLedger(Date.now, 10); const gate = deferred(); let calls = 0;
  assert.deepEqual(await ledger.execute("late", {}, () => { calls++; return gate.promise; }), { status: "pending" });
  assert.deepEqual(await ledger.execute("late", {}, () => assert.fail("duplicate")), { status: "pending" });
  gate.resolve({ status: "accepted", response: "late response" }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await ledger.execute("late", {}, () => assert.fail("duplicate")), { status: "accepted", response: "late response" });
  assert.equal(calls, 1);
});

test("ControlQueue 串行执行且失败不阻塞后续", async () => {
  const queue = new ControlQueue(); const gate = deferred(); const order = [];
  const first = queue.run(async () => { order.push("first:start"); await gate.promise; order.push("first:end"); return 1; });
  const second = queue.run(async () => { order.push("second"); throw new Error("second failed"); });
  const rejection = assert.rejects(second, /second failed/);
  const third = queue.run(async () => { order.push("third"); return 3; });
  await Promise.resolve(); assert.deepEqual(order, ["first:start"]);
  gate.resolve(); assert.equal(await first, 1); await rejection; assert.equal(await third, 3);
  assert.deepEqual(order, ["first:start", "first:end", "second", "third"]);
});

for (const version of [1, 2, 3]) test(`parseSession v${version} 内存迁移与截断跳过，不写源文件`, async t => {
  const { home } = await fixture(t);
  const records = [
    { type: "session", version, id: "session" },
    entry("a", null, { role: version < 3 ? "hookMessage" : "custom", content: "hook" }),
    entry("b", "a"),
    ...(version === 1 ? [{ type: "compaction", firstKeptEntryIndex: 1, summary: "summary" }] : []),
  ];
  const bytes = Buffer.from(records.map(JSON.stringify).join("\n") + '\n\n42\n{"type":"message","id":');
  const file = path.join(home, "session.jsonl"); await writeFile(file, bytes);
  const parsed = await readSession(file);
  assert.equal(parsed.header.version, 3); assert.equal(parsed.entries[0].message.role, "custom");
  assert.equal(parsed.diagnostics.length, 2); assert.match(parsed.diagnostics[1], /不完整/);
  assert.equal(parsed.leafId, parsed.entries.at(-1).id);
  if (version === 1) {
    assert.equal(parsed.entries[0].parentId, null);
    assert.equal(parsed.entries[1].parentId, parsed.entries[0].id);
    assert.equal(parsed.entries[2].firstKeptEntryId, parsed.entries[0].id);
    assert.equal("firstKeptEntryIndex" in parsed.entries[2], false);
  } else assert.deepEqual(parsed.entries.map(e => [e.id, e.parentId]), [["a", null], ["b", "a"]]);
  assert.deepEqual(await readFile(file), bytes);
});

test("parseSession 空文件、无文件与不支持版本", async t => {
  const { home } = await fixture(t);
  assert.deepEqual(parseSession(""), { header: undefined, entries: [], leafId: null, diagnostics: [] });
  assert.deepEqual(await readSession(path.join(home, "missing")), { entries: [], leafId: null, diagnostics: [] });
  assert.throws(() => parseSession('{"type":"session","version":4}'), code("sessionVersion"));
});

test("图片标记按顺序还原，保留普通消息与原输入", () => {
  const images = [image(0), image(1)];
  const source = user("before⟦pane-img:abc123:1⟧between⟦pane-img:abc123:2⟧after", images);
  const saved = structuredClone(source);
  const restored = restoreImages(source);
  assert.deepEqual(restored.message.content, [{ type: "text", text: "before[Image #1]" }, images[0], { type: "text", text: "between[Image #2]" }, images[1], { type: "text", text: "after" }]);
  assert.deepEqual(source, saved);
  assert.deepEqual(restoreImages(user("normal")), {});
  assert.deepEqual(restoreImages({ role: "assistant", content: source.content }), {});
});

test("图片标记非法数量、nonce、序号或语法均不恢复", () => {
  for (const text of ["⟦pane-img:abc123:2⟧", "⟦pane-img:abc123:0⟧", "⟦pane-img:bad:1⟧", "⟦pane-img:ABC123:1⟧", "⟦pane-img:abc123:1", "⟦pane-img:abc123:1⟧⟦pane-img:abc123:2⟧"]) {
    assert.deepEqual(restoreImages(user(text)), { invalid: true }, text);
  }
  assert.deepEqual(restoreImages(user("⟦pane-img:abc123:1⟧⟦pane-img:def456:2⟧", [image(), image(1)])), { invalid: true });
  assert.deepEqual(restoreImages(user("⟦pane-img:abc123:1⟧", [])), { invalid: true });
});

test("图片标记不能在合法标记旁静默保留非法标记", () => {
  assert.deepEqual(restoreImages(user("⟦pane-img:abc123:1⟧⟦pane-img:bad:2⟧")), { invalid: true });
});

test("AssetStore hash、MIME 文件头与缩略图校验", async t => {
  const { assets } = await fixture(t); const data = png();
  assert.equal(hashId(data), "sha256-" + createHash("sha256").update(data).digest("hex"));
  assert.deepEqual(imageInfo(data, "image/png"), { mimeType: "image/png", width: 24, height: 24 });
  assert.deepEqual(imageInfo(thumb, "image/webp"), { mimeType: "image/webp", width: 1, height: 1 });
  assert.throws(() => imageInfo(data, "image/jpeg"), code("invalidImage"));
  assert.throws(() => imageInfo(Buffer.from("not an image")), code("invalidImage"));
  assert.throws(() => assets.upload(data, "image/jpeg", thumb), code("invalidImage"));
  assert.throws(() => assets.upload(data, "image/png", data), code("invalidImage"));
  assert.throws(() => assets.upload(data, "image/png", Buffer.alloc(512 * 1024 + 1)), code("thumbnailTooLarge"));
  const largeThumb = Buffer.from(thumb); largeThumb.writeUInt16LE(257, 26);
  assert.throws(() => assets.upload(data, "image/png", largeThumb), code("invalidThumbnail"));
});

test("AssetStore 严格拒绝非法 hash 与路径穿越", async t => {
  const { assets } = await fixture(t);
  for (const id of ["../escape", "sha256-" + "a".repeat(63), "sha256-" + "A".repeat(64), "sha256-" + "g".repeat(64), "sha256-" + "a".repeat(64) + "/../../escape", "sha256-" + "a".repeat(64) + "\n"]) {
    for (const action of [() => assets.asset(id), () => assets.blob(id), () => assets.touch([id])]) assert.throws(action, code("invalidAssetId"), id);
  }
  assert.throws(() => assets.asset("sha256-" + "0".repeat(64)), code("assetMissing"));
  assert.throws(() => assets.blob("sha256-" + "0".repeat(64)), code("blobMissing"));
});

test("AssetStore 单张 4 MiB、10 张与总量 12 MiB 的包含边界", async t => {
  const { assets } = await fixture(t);
  assert.equal(MAX_IMAGE_BYTES, 4 * 1024 * 1024); assert.equal(MAX_MESSAGE_IMAGES, 10); assert.equal(MAX_MESSAGE_IMAGE_BYTES, 12 * 1024 * 1024);
  const large = png(0, 24, 24, MAX_IMAGE_BYTES);
  const big = assets.upload(large, "image/png", thumb).assetId;
  assert.throws(() => assets.upload(png(0, 24, 24, MAX_IMAGE_BYTES + 1), "image/png", thumb), code("imageTooLarge"));
  const small = assets.upload(png(1), "image/png", thumb).assetId;
  const node = assetId => ({ type: "image", assetId });
  assert.equal(assets.encode(Array.from({ length: 10 }, () => node(small)), true).images.length, 10);
  assert.throws(() => assets.encode(Array.from({ length: 11 }, () => node(small)), true), code("imagesTooLarge"));
  assert.equal(assets.encode([node(big), node(big), node(big)], true).images.length, 3);
  assert.throws(() => assets.encode([node(big), node(big), node(big), node(small)], true), code("imagesTooLarge"));
  assert.throws(() => assets.encode([node(small)], false), code("imageUnsupported"));
});

test("AssetStore encode 与 bridge restore 保持文本图片顺序", async t => {
  const { assets } = await fixture(t);
  const one = assets.upload(png(0), "image/png", thumb).assetId;
  const two = assets.upload(png(1), "image/png", thumb).assetId;
  const encoded = assets.encode([{ type: "text", text: "one" }, { type: "image", assetId: one }, { type: "text", text: "two" }, { type: "image", assetId: two }, { type: "text", text: "end" }], true);
  assert.match(encoded.message, /^one⟦pane-img:[a-f0-9]{8}:1⟧two⟦pane-img:[a-f0-9]{8}:2⟧end$/);
  const restored = restoreImages(user(encoded.message, encoded.images));
  assert.deepEqual(restored.message.content.filter(b => b.type === "text").map(b => b.text), ["one[Image #1]", "two[Image #2]", "end"]);
  assert.deepEqual(restored.message.content.filter(b => b.type === "image").map(b => b.data), [png(0).toString("base64"), png(1).toString("base64")]);
});

test("AssetStore touch、读取与重复上传延长保留，清理删除三个文件", async t => {
  let now = 100; const { home, assets } = await fixture(t, { now: () => now });
  const data = png(); const { assetId } = assets.upload(data, "image/png", thumb);
  const hex = assetId.slice(7); const directory = path.join(home, "assets", hex.slice(0, 2));
  const metaFile = path.join(directory, hex + ".json");
  now += DAY; assert.deepEqual(assets.touch([assetId, "sha256-" + "0".repeat(64)]), { missing: ["sha256-" + "0".repeat(64)] });
  assert.equal(JSON.parse(await readFile(metaFile, "utf8")).lastUsedAt, now);
  now += DAY; assert.deepEqual(assets.asset(assetId).data, data);
  assert.equal(assets.asset(assetId, true).mimeType, "image/webp");
  assert.equal(JSON.parse(await readFile(metaFile, "utf8")).lastUsedAt, now);
  now += DAY; assets.upload(data, "image/png", thumb);
  assert.equal(JSON.parse(await readFile(metaFile, "utf8")).createdAt, 100);
  now += 7 * DAY; assets.sweep(); assert.deepEqual(assets.touch([assetId]), { missing: [] });
  now += 7 * DAY + 1; assets.sweep();
  assert.deepEqual(assets.touch([assetId]), { missing: [assetId] });
  assert.deepEqual(await readdir(directory), []);
});

test("AssetStore blob 引用递归脱离 base64，LRU 清理保留最近访问", async t => {
  let now = 1; const first = png(0); const second = png(1);
  const { assets, model } = await fixture(t, { now: () => now, maxCacheBytes: Math.max(first.length, second.length) });
  const source = { nested: [image(0), { deeper: image(1) }] }; const saved = structuredClone(source);
  const detached = assets.detach(source);
  assert.deepEqual(source, saved);
  assert.equal(detached.nested[0].blob, hashId(first));
  assert.equal(detached.nested[0].size, first.length);
  assert.equal(detached.nested[0].width, 24);
  assert.equal("data" in detached.nested[0], false);
  assert.equal("data" in detached.nested[1].deeper, false);
  now++; assert.deepEqual(assets.blob(hashId(first)).data, first);
  assets.sweep();
  assert.deepEqual(assets.blob(hashId(first)).data, first);
  assert.throws(() => assets.blob(hashId(second)), code("blobMissing"));
  model.reset([entry("picture", null, { role: "user", content: [image(0)] })], "picture");
  const snapshot = model.snapshot();
  assert.equal(snapshot.entries[0].message.content[0].blob, hashId(first));
  assert.equal("data" in snapshot.entries[0].message.content[0], false);
  const emitted = model.emit({ type: "message_end", message: { role: "assistant", content: [image(0)] } });
  assert.equal("data" in emitted.event.message.content[0], false);
});
