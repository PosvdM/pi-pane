// 停止、关闭结果的续取与服务端保存的清出草稿的取回（packages/web/src/lib/server-drafts.ts）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  FLIGHT_GRACE_MS, FLIGHT_HELD_RECHECK_MS, ackPrefix, attachComposer, batchPrefix, beginStop, releaseStop, sessionsWithServerWork,
  settleServerDrafts, stopPrefix, takePending,
} from "../packages/web/src/lib/restored.ts";
import { ORPHAN_MS, PENDING_RECHECK_MS, UNAVAILABLE_RECHECK_MS, recoverServerDrafts } from "../packages/web/src/lib/server-drafts.ts";

class MemoryStorage {
  items = new Map();
  get length() { return this.items.size; }
  key(i) { return [...this.items.keys()][i] ?? null; }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) { this.items.set(key, String(value)); }
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
function composer() {
  const box = { received: [], messages: [] };
  box.handle = { deliver: (drafts, message) => { box.received.push(drafts); box.messages.push(message); } };
  return box;
}
/** 模拟服务端：results 为 requestId → 控制结果或错误，records 为会话 id → 保存的记录。 */
function fakeServer() {
  const server = { results: new Map(), records: new Map(), calls: [], down: false, removeDown: false };
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
    if (!body) return { records: structuredClone(server.records.get(sessionId) ?? []) };
    if (server.removeDown) throw failure(0, "network");
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
  assert.equal(await recoverServerDrafts(deps(storage, locks, server), "A", true), null);
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
