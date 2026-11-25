// 停止、关闭结果的续取与服务端保存的清出草稿的取回（packages/web/src/lib/server-drafts.ts）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  FLIGHT_GRACE_MS, FLIGHT_HELD_RECHECK_MS, ackPrefix, attachComposer, batchPrefix, beginStop, deferredIds, deferredSettled, finalizeStop, releaseStop,
  saveDraft, sessionsWithServerWork, settleServerDrafts, stopFlights, stopPrefix, takePending, unsavedSessions,
} from "../packages/web/src/lib/restored.ts";
import { ORPHAN_MS, PENDING_RECHECK_MS, REPLAY_MS, UNAVAILABLE_RECHECK_MS, recoverServerDrafts as recoverNext } from "../packages/web/src/lib/server-drafts.ts";

/** 只看下一次续取的延迟；需要同时核对是否再读取记录时直接用 recoverNext。 */
const recoverServerDrafts = async (...args) => (await recoverNext(...args))?.delay ?? null;

class MemoryStorage {
  items = new Map();
  /** full 为 true 时写入抛出 QuotaExceededError。 */
  full = false;
  get length() { return this.items.size; }
  key(i) { return [...this.items.keys()][i] ?? null; }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) {
    if (this.full) throw Object.assign(new Error("配额已满"), { name: "QuotaExceededError" });
    this.items.set(key, String(value));
  }
  removeItem(key) { this.items.delete(key); }
}
function fakeLocks() {
  const locks = { held: new Set() };
  locks.request = async (name, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (options.ifAvailable && locks.held.has(name)) return callback(null);
    while (locks.held.has(name)) await new Promise((resolve) => setTimeout(resolve, 1));
    locks.held.add(name);
    try { return await callback({ name }); } finally { locks.held.delete(name); }
  };
  return locks;
}
const text = (value) => [{ type: "text", text: value }];
const sure = (nodes) => ({ nodes, uncertain: false });
const unsure = (nodes) => ({ nodes, uncertain: true });
const failure = (status, code) => Object.assign(new Error(code), { status, code });
/** 模拟输入框；saves 为 false 时放回的草稿没能写入 localStorage（只在页面内存中）。 */
function composer() {
  const box = { received: [], messages: [], saves: true };
  box.handle = { deliver: (drafts, message) => { box.received.push(drafts); box.messages.push(message); return box.saves; }, mirror: () => {} };
  return box;
}
/** 模拟服务端：results 为 requestId → 控制结果或错误，records 为会话 id → 保存的记录。 */
function fakeServer() {
  const server = { results: new Map(), records: new Map(), calls: [], down: false, removeDown: false, listDown: false, removePending: false };
  server.call = async (path, body) => {
    server.calls.push({ path, body });
    if (server.down) throw failure(0, "network");
    const [, id, operation] = /^\/api\/sessions\/([^/]+)\/(control|drafts)$/.exec(path);
    const sessionId = decodeURIComponent(id);
    if (operation === "control") {
      const result = server.results.get(body.requestId);
      if (result instanceof Error) throw result;
      if (!result) throw failure(404, "sessionMissing");
      return structuredClone(result);
    }
    if (!body) {
      if (server.listDown) throw failure(500, "internal");
      return { records: structuredClone(server.records.get(sessionId) ?? []) };
    }
    if (server.removeDown) throw failure(0, "network");
    if (server.removePending) return { status: "pending" };
    server.records.set(sessionId, (server.records.get(sessionId) ?? []).filter((record) => !body.remove.includes(record.id)));
    return { status: "done" };
  };
  return server;
}
let ids = 0;
const deps = (storage, locks, server, now = () => 100_000) => ({ storage, locks, call: server.call, newId: () => `ack-${++ids}`, now });
const orphan = (storage, sessionId, requestId, at = 1_000) => {
  const key = stopPrefix(sessionId) + `${at}-${requestId}`;
  storage.setItem(key, JSON.stringify({ at, sessionId, body: { requestId, expectedEpoch: "e", expectedRevision: 1, command: { type: "stop" } } }));
  return key;
};
const stops = (storage, sessionId) => [...storage.items.keys()].filter((key) => key.startsWith(stopPrefix(sessionId)));
const acks = (storage, sessionId) => [...storage.items.keys()].filter((key) => key.startsWith(ackPrefix(sessionId)));
const done = (cleared, uncertain) => ({ status: "done", clearedText: cleared.map((d) => d[0].text), clearedDrafts: cleared, ...(uncertain ? { uncertainDrafts: uncertain } : {}) });

test("#11 发起页面刷新或关闭后，同一 requestId 续取停止结果，放回原会话并请服务端删除副本", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const a = composer(); const detach = attachComposer("A", a.handle);
  const key = orphan(storage, "A", "r1");
  server.results.set("r1", done([text("排队一")], [text("归属不明")]));
  server.records.set("A", [{ id: "r1", reason: "stop", at: new Date(1_000).toISOString(), drafts: [sure(text("排队一")), unsure(text("归属不明"))] }]);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", true), null);
  assert.deepEqual(a.received, [[sure(text("排队一")), unsure(text("归属不明"))]]);
  assert.deepEqual(a.messages, ["排队中的消息已放回输入框"]);
  assert.equal(storage.getItem(key), null, "取回后删除在途请求");
  assert.deepEqual(acks(storage, "A"), [], "服务端删除后移除待删除登记");
  assert.deepEqual(server.records.get("A"), []);
  assert.deepEqual(server.calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body.requestId), ["r1"], "只续取一次");
  // 取回后再次续取（例如又刷新）不重复放回。
  await recoverServerDrafts(deps(storage, locks, server), "A", true);
  assert.equal(a.received.length, 1);
  detach();
});

test("#11 续取的时机：保护期内、锁被持有（发起页面仍在等待）时稍后重查，停止仍在执行时按 pending 重查", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const a = composer(); const detach = attachComposer("A", a.handle);
  const young = orphan(storage, "A", "young", 99_500);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", false), FLIGHT_GRACE_MS - 500);
  storage.removeItem(young);

  const held = orphan(storage, "A", "held"); locks.held.add(held);
  server.results.set("held", { status: "pending" });
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", false), FLIGHT_HELD_RECHECK_MS, "另一页面仍在等待时不续取");
  assert.equal(server.calls.length, 0);
  locks.held.delete(held);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", false), PENDING_RECHECK_MS, "停止仍在执行");
  assert.notEqual(storage.getItem(held), null);
  server.results.set("held", done([text("迟到的结果")]));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", false), null);
  assert.deepEqual(a.received, [[sure(text("迟到的结果"))]]);
  assert.equal(storage.getItem(held), null);

  // 本页面仍在等待的请求不续取。
  const mine = beginStop(storage, "A", { requestId: "mine" }, locks);
  server.results.set("mine", done([text("本页")]));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server, () => Date.now() + 60_000), "A", false), null);
  assert.equal(a.received.length, 1);
  releaseStop(mine.key);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server, () => Date.now() + 60_000), "A", false), null);
  assert.deepEqual(a.received.at(-1), [sure(text("本页"))], "本页面不再等待（结果未知）后续取");
  detach();
});

test("#11 断网超过重试期限：网络恢复前保留在途请求并定时重查，恢复后续取；需要重新配对时停止重查", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const key = orphan(storage, "B", "r1");
  server.results.set("r1", done([text("断网期间清出")]));
  server.down = true;
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "B", true), UNAVAILABLE_RECHECK_MS);
  assert.notEqual(storage.getItem(key), null);
  server.down = false; server.results.set("r1", failure(503, "serverStopping"));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "B", false), UNAVAILABLE_RECHECK_MS, "服务端正在关闭时稍后再试");
  server.results.set("r1", failure(401, "unauthorized"));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "B", false), null, "需要重新配对时等待连接建立后再续取");
  assert.notEqual(storage.getItem(key), null);
  assert.deepEqual(sessionsWithServerWork(storage), ["B"], "连接建立时按在途请求找到需要续取的会话");
  server.results.set("r1", done([text("断网期间清出")]));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "B", false), null);
  // 输入框未挂载：进入该会话的待放回记录。
  assert.equal([...storage.items.keys()].filter((k) => k.startsWith(batchPrefix("B"))).length, 1);
  const b = composer(); const detach = attachComposer("B", b.handle);
  takePending(storage, "B");
  assert.deepEqual(b.received, [[sure(text("断网期间清出"))]]);
  assert.deepEqual(sessionsWithServerWork(storage), []);
  detach();
});

test("#11 服务端重启后幂等记录不在：按 requestId 读取服务端保存的记录；请求被拒绝且没有记录时删除在途请求", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const a = composer(); const detach = attachComposer("A", a.handle);
  const restarted = orphan(storage, "A", "r1");
  server.results.set("r1", failure(409, "epochChanged"));
  server.records.set("A", [
    { id: "r1", reason: "close", at: new Date(1_000).toISOString(), drafts: [sure(text("关闭时清出")), unsure(text("可能已发送"))] },
    { id: "r-other", reason: "stop", at: new Date(99_000).toISOString(), drafts: [sure(text("另一浏览器刚清出"))] },
  ]);
  assert.deepEqual(await recoverNext(deps(storage, locks, server), "A", true), { delay: ORPHAN_MS - 1_000, saved: true }, "另一浏览器的记录到期时再读取");
  assert.deepEqual(a.received, [[sure(text("关闭时清出")), unsure(text("可能已发送"))]], "不取走另一浏览器中可能仍在等待的记录");
  assert.equal(storage.getItem(restarted), null);
  assert.deepEqual(server.records.get("A").map((record) => record.id), ["r-other"]);

  const rejected = orphan(storage, "A", "r2");
  server.results.set("r2", failure(409, "revisionChanged"));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", false), null);
  assert.equal(storage.getItem(rejected), null, "请求被拒绝、没有保存的记录时只删除在途请求");
  assert.equal(a.received.length, 1);

  // 没有对应在途请求的停止记录超过 ORPHAN_MS 后取回。
  await recoverServerDrafts(deps(storage, locks, server, () => 99_000 + ORPHAN_MS), "A", true);
  assert.deepEqual(a.received.at(-1), [sure(text("另一浏览器刚清出"))]);
  assert.deepEqual(server.records.get("A"), []);
  detach();
});

test("#10 服务端关停时保存的草稿在打开会话时放回并提示，两个标签页只放回一次；服务端删除失败时不重复放回", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const a = composer(); const detach = attachComposer("A", a.handle);
  server.records.set("A", [{ id: "s1", reason: "shutdown", at: new Date(99_900).toISOString(), drafts: [sure([{ type: "text", text: "图 " }, { type: "image", assetId: "sha256-" + "a".repeat(64) }])] }]);
  server.removeDown = true;
  const tabs = await Promise.all([recoverServerDrafts(deps(storage, locks, server), "A", true), recoverServerDrafts(deps(storage, locks, server), "A", true)]);
  assert.deepEqual(tabs, [UNAVAILABLE_RECHECK_MS, UNAVAILABLE_RECHECK_MS]);
  assert.equal(a.received.length, 1, "两个标签页串行续取，只放回一次");
  assert.deepEqual(a.messages, ["服务端关闭前排队的消息已放回输入框"]);
  assert.equal(acks(storage, "A").length, 1, "删除失败时保留待删除登记");
  // 取回后刷新：服务端仍有记录，但已登记为待删除，不再放回。
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", true), UNAVAILABLE_RECHECK_MS);
  assert.equal(a.received.length, 1);
  server.removeDown = false;
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", true), null);
  assert.deepEqual(acks(storage, "A"), []);
  assert.deepEqual(server.records.get("A"), []);
  assert.equal(a.received.length, 1);
  detach();
});

test("放回服务端草稿时先登记待删除再删除在途请求", () => {
  const storage = new MemoryStorage(); const writes = [];
  const set = storage.setItem.bind(storage); const remove = storage.removeItem.bind(storage);
  storage.setItem = (key, value) => { writes.push(["set", key.split(".")[1]]); set(key, value); };
  storage.removeItem = (key) => { writes.push(["remove", key.split(".")[1]]); remove(key); };
  const key = orphan(storage, "C", "r1"); writes.length = 0;
  settleServerDrafts(storage, "C", ["r1"], [sure(text("x"))], null, key);
  assert.deepEqual(writes, [["set", "restored"], ["set", "ack"], ["remove", "stopflight"]]);
});

test("放回的草稿没能写入 localStorage、只在页面内存中时，不删除服务端副本，本页面也不重复放回；写入后再删除", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  server.records.set("满", [{ id: "s1", reason: "shutdown", at: new Date(99_000).toISOString(), drafts: [sure(text("关停时排队"))] }]);
  const key = orphan(storage, "满", "r1");
  server.results.set("r1", done([text("停止时清出")]));
  storage.full = true;
  // 输入框未挂载：待放回记录写入失败，进入内存。
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "满", true), null);
  assert.ok(unsavedSessions.get().has("满"));
  assert.deepEqual(acks(storage, "满"), [], "不登记删除");
  assert.deepEqual(server.records.get("满").map((record) => record.id), ["s1"], "服务端副本保留");
  assert.deepEqual(deferredIds("满").sort(), ["r1", "s1"]);
  assert.equal(storage.getItem(key), null, "停止结果已取回，在途请求删除");
  // 本页面再次续取不重复放回，也不删除服务端副本。
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "满", true), null);
  assert.equal(server.calls.filter((call) => call.body?.remove).length, 0);
  // 输入框挂载时取走内存中的批次，保存输入框内容仍然失败，草稿继续留在内存。
  const box = composer(); let content = [];
  box.handle.deliver = (drafts) => { box.received.push(drafts); content = [...drafts.flatMap((draft) => draft.nodes), ...content]; return saveDraft(storage, "满", content); };
  const detach = attachComposer("满", box.handle);
  assert.equal(takePending(storage, "满"), true);
  assert.equal(box.received.flat().length, 2, "内存中的两批都在，只放回一次");
  assert.ok(unsavedSessions.get().has("满"));
  assert.deepEqual(acks(storage, "满"), []);
  // 空间恢复，输入框保存成功：记录转为待删除登记，之后请服务端删除。
  storage.full = false; const settled = [];
  const off = deferredSettled.subscribe(() => settled.push(...deferredSettled.get()));
  assert.equal(saveDraft(storage, "满", text("停止时清出\n\n关停时排队")), true);
  off();
  assert.deepEqual(settled, ["满"]);
  assert.equal(unsavedSessions.get().has("满"), false);
  assert.deepEqual(deferredIds("满"), []);
  assert.equal(acks(storage, "满").length, 1);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "满", true), null);
  assert.deepEqual(server.records.get("满"), []);
  assert.deepEqual(acks(storage, "满"), []);
  detach();
});

test("输入框保存失败时同样保留服务端副本", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  server.records.set("盒", [{ id: "s1", reason: "exit", at: new Date(99_000).toISOString(), drafts: [sure(text("写者停止时排队"))] }]);
  const box = composer(); box.saves = false; const detach = attachComposer("盒", box.handle);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "盒", true), null);
  assert.deepEqual(box.messages, ["会话停止时排队的消息已放回输入框"]);
  assert.deepEqual(acks(storage, "盒"), []);
  assert.deepEqual(deferredIds("盒"), ["s1"]);
  assert.equal(server.records.get("盒").length, 1);
  await recoverServerDrafts(deps(storage, locks, server), "盒", true);
  assert.equal(box.received.length, 1);
  detach();
});

test("续取的重查时机：读取记录暂时失败、另一浏览器的停止记录未到期时，安排到期后再读取记录", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const box = composer(); const detach = attachComposer("时", box.handle);
  server.records.set("时", [{ id: "s1", reason: "shutdown", at: new Date(90_000).toISOString(), drafts: [sure(text("关停"))] }]);
  server.listDown = true;
  assert.deepEqual(await recoverNext(deps(storage, locks, server), "时", true), { delay: UNAVAILABLE_RECHECK_MS, saved: true }, "读取失败后重试时仍读取记录");
  server.listDown = false;
  assert.equal(await recoverNext(deps(storage, locks, server), "时", true), null);
  assert.deepEqual(box.received, [[sure(text("关停"))]]);

  server.records.set("时", [{ id: "other", reason: "close", at: new Date(40_000).toISOString(), drafts: [sure(text("另一浏览器关闭"))] }]);
  const next = await recoverNext(deps(storage, locks, server), "时", true);
  assert.deepEqual(next, { delay: ORPHAN_MS - 60_000, saved: true });
  assert.equal(box.received.length, 1);
  assert.equal(await recoverNext(deps(storage, locks, server, () => 100_000 + next.delay), "时", next.saved), null);
  assert.deepEqual(box.received.at(-1), [sure(text("另一浏览器关闭"))]);
  detach();
});

test("续取时服务端缓存了停止后续步骤的失败（5xx）：按 requestId 读取已保存的记录，不当作暂时错误无限重试", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const box = composer(); const detach = attachComposer("败", box.handle);
  const key = orphan(storage, "败", "r1");
  server.results.set("r1", failure(500, "stopFailed"));
  server.records.set("败", [{ id: "r1", reason: "stop", at: new Date(1_000).toISOString(), drafts: [sure(text("已落盘"))] }]);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "败", false), null);
  assert.deepEqual(box.received, [[sure(text("已落盘"))]]);
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(server.records.get("败"), []);
  // 服务端正在关闭（请求没有到达幂等记录）时仍按暂时错误重试。
  const closing = orphan(storage, "败", "r2");
  server.results.set("r2", failure(503, "serverStopping"));
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "败", false), UNAVAILABLE_RECHECK_MS);
  assert.notEqual(storage.getItem(closing), null);
  detach();
});

test("删除服务端记录返回 pending 时保留待删除登记，稍后再删，不重复放回", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const box = composer(); const detach = attachComposer("慢", box.handle);
  server.records.set("慢", [{ id: "s1", reason: "shutdown", at: new Date(99_000).toISOString(), drafts: [sure(text("关停"))] }]);
  server.removePending = true;
  assert.deepEqual(await recoverNext(deps(storage, locks, server), "慢", true), { delay: PENDING_RECHECK_MS, saved: false });
  assert.equal(acks(storage, "慢").length, 1, "保留登记");
  await recoverServerDrafts(deps(storage, locks, server), "慢", true);
  assert.equal(box.received.length, 1, "记录仍在服务端，但已登记待删除，不再放回");
  server.removePending = false;
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "慢", true), null);
  assert.deepEqual(acks(storage, "慢"), []);
  detach();
});

test("服务端明确拒绝的停止或关闭不再重新提交，只核对服务端记录；超过 REPLAY_MS 的在途请求同样只核对记录", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  const box = composer(); const detach = attachComposer("拒", box.handle);
  // 用户取消了保活确认后很快关闭页面：在途请求已标为结束，之后即使服务端会执行同一请求也不再提交。
  const cancelled = beginStop(storage, "拒", { requestId: "close-1", expectedEpoch: "e", expectedRevision: 1, command: { type: "close" } }, locks);
  finalizeStop(storage, cancelled);
  assert.equal(stopFlights(storage, "拒")[0].final, true);
  server.results.set("close-1", { status: "done", clearedText: [], clearedDrafts: [] });
  assert.equal(await recoverServerDrafts(deps(storage, locks, server, () => Date.now()), "拒", false), null, "不等保护期");
  assert.deepEqual(server.calls.filter((call) => call.path.endsWith("/control")), [], "不重新提交");
  assert.equal(storage.getItem(cancelled.key), null);

  const old = orphan(storage, "拒", "old", 1_000);
  server.results.set("old", done([text("不应重新执行")]));
  server.records.set("拒", [{ id: "old", reason: "stop", at: new Date(1_000).toISOString(), drafts: [sure(text("已保存"))] }]);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server, () => 1_000 + REPLAY_MS), "拒", false), null);
  assert.deepEqual(server.calls.filter((call) => call.path.endsWith("/control")), [], "幂等记录可能已过期，不重新提交");
  assert.deepEqual(box.received, [[sure(text("已保存"))]]);
  assert.equal(storage.getItem(old), null);
  detach();
});

test("输入框未挂载时取回的服务端草稿进入待放回记录，挂载时显示该记录的通知", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks(); const server = fakeServer();
  server.records.set("后", [{ id: "s1", reason: "shutdown", at: new Date(99_000).toISOString(), drafts: [sure(text("关停"))] }]);
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "后", true), null);
  const box = composer(); const detach = attachComposer("后", box.handle);
  assert.equal(takePending(storage, "后"), true);
  assert.deepEqual(box.messages, ["服务端关闭前排队的消息已放回输入框"]);
  detach();
});
