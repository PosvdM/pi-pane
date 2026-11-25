import test from "node:test";
import assert from "node:assert/strict";
import { mergeDrafts, prependDrafts } from "../packages/web/src/lib/draft.ts";
import {
  FLIGHT_GRACE_MS, FLIGHT_STALE_MS, addNotice, attachComposer, batchPrefix, beginSubmit, clearNotice, commitDraft, deliverRestored, draftKey, encodeId,
  finishSubmit, flightPrefix, FLIGHT_HELD_RECHECK_MS, loadDraft, loadNotice, noticeKey, readDraft, recoverFlights, saveDraft, takePending, unsavedSessions,
} from "../packages/web/src/lib/restored.ts";

class MemoryStorage {
  items = new Map();
  quota = Infinity;
  get length() { return this.items.size; }
  key(i) { return [...this.items.keys()][i] ?? null; }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) {
    const used = [...this.items].reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), 0);
    if (used + key.length + String(value).length > this.quota) throw Object.assign(new Error("配额已满"), { name: "QuotaExceededError" });
    this.items.set(key, String(value));
  }
  removeItem(key) { this.items.delete(key); }
}
const text = (value) => [{ type: "text", text: value }];
const image = (id) => [{ type: "text", text: "图 " }, { type: "image", assetId: id }];
const sure = (nodes) => ({ nodes, uncertain: false });
const unsure = (nodes) => ({ nodes, uncertain: true });
const batchKeys = (storage, id) => [...storage.items.keys()].filter((key) => key.startsWith(batchPrefix(id)));
const flightKeys = (storage, id) => [...storage.items.keys()].filter((key) => key.startsWith(flightPrefix(id)));
/** 模拟输入框：deliver 把草稿放在现有内容之前，received 记录每次放回的草稿，messages 记录通知。 */
function composer(onDeliver) {
  const box = { content: [], received: [], messages: [] };
  box.handle = {
    deliver: (drafts, message) => { onDeliver?.(drafts); box.received.push(drafts); box.messages.push(message); box.content = prependDrafts(drafts.map((d) => d.nodes), box.content); },
  };
  return box;
}
/** 模拟 Web Locks：held 中的锁视为被其他页面持有。 */
function fakeLocks() {
  const locks = { held: new Set(), requested: [] };
  locks.request = async (name, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    locks.requested.push(name);
    if (options.ifAvailable && locks.held.has(name)) return callback(null);
    locks.held.add(name);
    try { return await callback({ name }); } finally { locks.held.delete(name); }
  };
  return locks;
}

test("取回草稿：输入框已挂载时直接放回，未挂载时按会话保存为独立批次", () => {
  const storage = new MemoryStorage(); const a = composer(); const received = a.received;
  const detach = attachComposer("A", a.handle);
  assert.equal(deliverRestored(storage, "A", [sure(text("一")), unsure(image("a"))]), "composer");
  assert.deepEqual(received, [[sure(text("一")), unsure(image("a"))]]);
  // 其他会话的结果不进入 A 的输入框。
  assert.equal(deliverRestored(storage, "B", [sure(text("乙"))]), "stored");
  assert.equal(received.length, 1);
  assert.equal(batchKeys(storage, "B").length, 1);
  detach();
  assert.equal(deliverRestored(storage, "A", [sure(text("二"))]), "stored");
  assert.equal(received.length, 1);
  assert.equal(deliverRestored(storage, "A", [sure([{ type: "text", text: " " }])]), "none");
});

test("R9-5 取回草稿：多批都含归属不明项时逐条保留标记，后清出的批次在前", async () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", [sure(text("C1")), unsure(image("u1"))]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  deliverRestored(storage, "A", [sure(text("C2")), unsure(image("u2"))]);
  assert.equal(batchKeys(storage, "A").length, 2);
  assert.equal(takePending(storage, "A"), false, "输入框未挂载时不取");
  const a = composer(); const detach = attachComposer("A", a.handle);
  assert.equal(takePending(storage, "A"), true);
  assert.deepEqual(a.received, [[sure(text("C2")), unsure(image("u2")), sure(text("C1")), unsure(image("u1"))]]);
  assert.equal(a.received[0].filter((draft) => draft.uncertain).length, 2);
  assert.deepEqual(batchKeys(storage, "A"), [], "放回输入框后删除读到的记录");
  assert.equal(takePending(storage, "A"), false, "不得重复放回");
  detach();
});

test("取回草稿：同一毫秒内存入的多批，后到的批次在前", (t) => {
  const storage = new MemoryStorage();
  t.mock.method(Date, "now", () => 1_000);
  for (let i = 1; i <= 6; i++) deliverRestored(storage, "A", [sure(text(`第${i}批`))]);
  const a = composer(); const detach = attachComposer("A", a.handle);
  takePending(storage, "A");
  assert.deepEqual(a.received[0].map((draft) => draft.nodes[0].text), ["第6批", "第5批", "第4批", "第3批", "第2批", "第1批"]);
  detach();
});

test("取回草稿：会话 id 互为前缀时不取走其他会话的待放回记录", () => {
  const storage = new MemoryStorage();
  assert.equal(deliverRestored(storage, "a.b", [sure(text("属于 a.b"))]), "stored");
  assert.equal(deliverRestored(storage, "a%2Eb", [sure(text("属于 a%2Eb"))]), "stored");
  const a = composer(); const detachA = attachComposer("a", a.handle);
  assert.equal(takePending(storage, "a"), false);
  assert.deepEqual(a.received, []);
  const ab = composer(); const detachAb = attachComposer("a.b", ab.handle);
  assert.equal(takePending(storage, "a.b"), true);
  assert.deepEqual(ab.received, [[sure(text("属于 a.b"))]], "a.b 只取自己的记录");
  assert.equal(batchKeys(storage, "a%2Eb").length, 1);
  detachA(); detachAb();
  // 含孤立代理项的会话 id 不抛错，编码可区分。
  const lone = "坏\ud800id";
  assert.doesNotThrow(() => batchPrefix(lone));
  assert.equal(deliverRestored(storage, lone, [sure(text("孤立代理项"))]), "stored");
  assert.notEqual(encodeId("\ud800"), encodeId("\ud801"));
  assert.equal(encodeId("01a2-b_c"), "01a2-b_c");
  assert.doesNotMatch(encodeId("a.b%c\ud800"), /\./);
});

test("R9-6 取回草稿：取走旧批期间写入的新批不被删除", () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", [sure(text("旧批"))]);
  let first = true;
  const a = composer(() => {
    if (!first) return; first = false;
    // 另一标签页在输入框写入期间、删除记录之前存入新批（写入不经本页的输入框登记）。
    storage.setItem(batchPrefix("A") + "9999999999999-新", JSON.stringify({ at: 9999999999999, drafts: [unsure(image("新"))] }));
  });
  const detach = attachComposer("A", a.handle);
  takePending(storage, "A");
  assert.deepEqual(a.received, [[sure(text("旧批"))]]);
  assert.equal(batchKeys(storage, "A").length, 1, "只删除本次读到的记录");
  takePending(storage, "A");
  assert.deepEqual(a.received[1], [unsure(image("新"))]);
  detach();
});

test("取回草稿：输入框写入抛错时保留待放回记录，损坏的记录被清除", () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", [unsure(image("a"))]);
  const detach = attachComposer("A", composer(() => { throw new Error("写入失败"); }).handle);
  assert.throws(() => takePending(storage, "A"), /写入失败/);
  assert.equal(batchKeys(storage, "A").length, 1);
  detach();
  storage.setItem(batchPrefix("B") + "坏", "{坏");
  const detachB = attachComposer("B", composer(() => assert.fail("损坏的记录不应交给输入框")).handle);
  assert.equal(takePending(storage, "B"), false);
  assert.deepEqual(batchKeys(storage, "B"), []);
  detachB();
});

test("R9-1 取回草稿：localStorage 超出配额时草稿保存在内存并标记该会话，空间恢复后写回", () => {
  const storage = new MemoryStorage();
  storage.quota = 50;
  assert.equal(deliverRestored(storage, "满", [sure(text("很长的排队消息".repeat(10))), unsure(image("q"))]), "memory");
  assert.deepEqual(batchKeys(storage, "满"), []);
  assert.ok(unsavedSessions.get().has("满"), "该会话有只在内存中的记录");
  assert.equal(unsavedSessions.get().has("其他"), false);
  // 输入框挂载时仍能从内存取走，草稿保存同样失败时留在内存。
  const full = composer((drafts) => {
    assert.equal(saveDraft(storage, "满", drafts.flatMap((draft) => draft.nodes)), false);
  });
  const detach = attachComposer("满", full.handle);
  assert.equal(takePending(storage, "满"), true);
  detach();
  assert.equal(full.received[0].length, 2);
  assert.deepEqual(loadDraft(storage, "满"), [{ type: "text", text: "很长的排队消息".repeat(10) + "图 " }, { type: "image", assetId: "q" }], "读取时内存记录优先");
  assert.ok(unsavedSessions.get().has("满"), "草稿仍只在内存中");
  storage.quota = Infinity;
  assert.equal(saveDraft(storage, "满", text("已发送一部分")), true);
  assert.equal(storage.getItem(draftKey("满")), JSON.stringify(text("已发送一部分")));
  assert.equal(unsavedSessions.get().has("满"), false, "写回后清除标记");
  // 提示记录写入失败时同样留在内存。
  storage.quota = 10;
  addNotice(storage, "满", 1);
  assert.equal(loadNotice(storage, "满").count, 1);
  assert.ok(unsavedSessions.get().has("满"));
  storage.quota = Infinity;
  clearNotice(storage, "满");
  assert.equal(loadNotice(storage, "满"), null);
  assert.equal(unsavedSessions.get().has("满"), false);
});

test("取回草稿：注销旧输入框不影响同一会话新挂载的输入框", () => {
  const storage = new MemoryStorage(); const first = composer(); const second = composer();
  const detachFirst = attachComposer("A", first.handle);
  const detachSecond = attachComposer("A", second.handle);
  detachFirst();
  assert.equal(deliverRestored(storage, "A", [sure(text("新"))]), "composer");
  assert.deepEqual([first.received.length, second.received.length], [0, 1]);
  detachSecond();
});

test("归属不明提示：放回时累加条数，“知道了”或清空后移除，发送成功只移除提交前放回的", (t) => {
  const storage = new MemoryStorage();
  let now = 1_000; t.mock.method(Date, "now", () => now);
  assert.equal(loadNotice(storage, "A"), null);
  addNotice(storage, "A", 2);
  assert.deepEqual(loadNotice(storage, "A"), { count: 2, at: 1_000 });
  addNotice(storage, "A", 1);
  assert.deepEqual(loadNotice(storage, "A"), { count: 3, at: 1_001 }, "同一毫秒内再次放回，时间仍递增");
  assert.equal(loadNotice(storage, "B"), null, "只属于该会话");
  // 提交开始于 1_001：提交期间（同一时刻）放回的提示保留。
  clearNotice(storage, "A", 1_001);
  assert.equal(loadNotice(storage, "A").count, 3);
  clearNotice(storage, "A", 1_002);
  assert.equal(loadNotice(storage, "A"), null);
  assert.equal(storage.getItem(noticeKey("A")), null);
  now = 2_000; addNotice(storage, "A", 1);
  clearNotice(storage, "A");
  assert.equal(loadNotice(storage, "A"), null, "“知道了”或清空输入框时无条件移除");
});

test("在途提交：送达后丢弃，失败原样放回、结果无法确认时标记归属不明，不覆盖期间新写的内容", () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  const a = composer(); const detach = attachComposer("A", a.handle);
  const sent = beginSubmit(storage, "A", text("/quit\n"), locks);
  assert.deepEqual(JSON.parse(storage.getItem(sent.key)).nodes, text("/quit\n"), "提交内容按会话保存");
  assert.ok(locks.held.has(sent.key), "提交期间持有锁");
  finishSubmit(storage, sent, "sent");
  assert.deepEqual(flightKeys(storage, "A"), []);
  assert.deepEqual(a.received, [], "送达后不再改动输入框");

  a.content = text("期间新写的内容");
  const failed = beginSubmit(storage, "A", text("被拒绝的消息"), locks);
  finishSubmit(storage, failed, "failed");
  assert.deepEqual(a.received.at(-1), [sure(text("被拒绝的消息"))]);
  assert.equal(a.messages.at(-1), null, "确定失败时由调用方提示错误，放回不另发通知");
  assert.deepEqual(a.content, prependDrafts([text("被拒绝的消息")], text("期间新写的内容")));

  const unknown = beginSubmit(storage, "A", image("u"), locks);
  finishSubmit(storage, unknown, "unknown");
  assert.deepEqual(a.received.at(-1), [unsure(image("u"))]);
  assert.match(a.messages.at(-1), /结果无法确认/);
  assert.deepEqual(flightKeys(storage, "A"), []);
  detach();

  // 输入框已卸载（用户切到其他会话）：进入原会话的待放回记录。
  const away = beginSubmit(storage, "A", text("切走后失败"), locks);
  finishSubmit(storage, away, "failed");
  assert.equal(batchKeys(storage, "A").length, 1);
  assert.deepEqual(flightKeys(storage, "A"), []);
  const back = composer(); const detachBack = attachComposer("A", back.handle);
  takePending(storage, "A");
  assert.deepEqual(back.received, [[sure(text("切走后失败"))]]);
  detachBack();
});

test("在途提交：页面关闭后遗留的记录按结果无法确认放回，仍有页面等待的记录不动", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  const a = composer(); const detach = attachComposer("A", a.handle);
  // 本页面仍在等待的提交。
  const mine = beginSubmit(storage, "A", text("本页在途"), locks);
  // 其他页面仍在等待：锁被持有。
  const otherKey = flightPrefix("A") + "100-other";
  storage.setItem(otherKey, JSON.stringify({ at: 100, nodes: text("他页在途") }));
  locks.held.add(otherKey);
  // 已关闭的页面留下的记录：锁已释放。
  const orphanKey = flightPrefix("A") + "200-orphan";
  storage.setItem(orphanKey, JSON.stringify({ at: 200, nodes: text("页面关闭时在途") }));
  // 刚写入、还在保护期内的记录。
  const now = 10_000;
  const youngKey = flightPrefix("A") + `${now - 500}-young`;
  storage.setItem(youngKey, JSON.stringify({ at: now - 500, nodes: text("刚提交") }));
  storage.setItem(flightPrefix("A") + "300-bad", "{坏");

  assert.equal(await recoverFlights(storage, "A", locks, now), Math.min(FLIGHT_HELD_RECHECK_MS, FLIGHT_GRACE_MS - 500), "保护期内和锁被持有的记录稍后再查");
  assert.deepEqual(a.received, [[unsure(text("页面关闭时在途"))]]);
  assert.equal(storage.getItem(orphanKey), null);
  assert.notEqual(storage.getItem(otherKey), null);
  assert.notEqual(storage.getItem(mine.key), null);
  assert.equal(storage.getItem(flightPrefix("A") + "300-bad"), null, "损坏的记录清除");
  assert.equal(locks.requested.filter((k) => k === mine.key).length, 1, "本页面的记录不检查锁");
  // 再次检查不会重复放回。
  await recoverFlights(storage, "A", locks, now);
  assert.equal(a.received.length, 1);
  finishSubmit(storage, mine, "sent");
  storage.removeItem(youngKey);

  // 锁被持有的记录：只重查，不取走。持有的页面正常结束（删除记录）后释放锁，不放回。
  assert.equal(await recoverFlights(storage, "A", locks, now + FLIGHT_GRACE_MS), FLIGHT_HELD_RECHECK_MS);
  assert.notEqual(storage.getItem(otherKey), null);
  storage.removeItem(otherKey); locks.held.delete(otherKey);
  assert.equal(await recoverFlights(storage, "A", locks, now + FLIGHT_GRACE_MS), null);
  assert.equal(a.received.length, 1);
  detach();

  // 没有 Web Locks 时只取超过时限的记录。
  const plain = new MemoryStorage();
  plain.setItem(flightPrefix("B") + "1000-old", JSON.stringify({ at: 1_000, nodes: text("很久以前") }));
  plain.setItem(flightPrefix("B") + "9000-new", JSON.stringify({ at: 9_000, nodes: text("不久以前") }));
  assert.equal(await recoverFlights(plain, "B", null, 1_000 + FLIGHT_STALE_MS), 8_000);
  assert.equal(batchKeys(plain, "B").length, 1, "输入框未挂载时进入待放回记录");
  const b = composer(); const detachB = attachComposer("B", b.handle);
  takePending(plain, "B");
  assert.deepEqual(b.received, [[unsure(text("很久以前"))]]);
  detachB();
});

test("#17 在途提交：刷新时旧页面尚未释放锁的过期记录稍后重查，锁释放后按结果无法确认放回", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  const a = composer(); const detach = attachComposer("A", a.handle);
  const key = flightPrefix("A") + "1000-reload";
  storage.setItem(key, JSON.stringify({ at: 1_000, nodes: text("刷新前在途") }));
  locks.held.add(key); // 旧页面尚未销毁，仍持有锁。
  const now = 1_000 + FLIGHT_GRACE_MS + 5_000;
  assert.equal(await recoverFlights(storage, "A", locks, now), FLIGHT_HELD_RECHECK_MS, "已过保护期但锁被持有时仍要重查");
  assert.deepEqual(a.received, []);
  assert.notEqual(storage.getItem(key), null);
  locks.held.delete(key); // 旧页面销毁，锁释放。
  assert.equal(await recoverFlights(storage, "A", locks, now + FLIGHT_HELD_RECHECK_MS), null);
  assert.deepEqual(a.received, [[unsure(text("刷新前在途"))]]);
  assert.equal(storage.getItem(key), null);
  detach();
});


test("草稿合并：一方只在开头或末尾增加时接到另一方的同一端；其余两份都保留，存储内容在前；相同内容不重复", () => {
  const nodes = (...parts) => prependDrafts([], []).concat(...parts.map((part) => typeof part === "string" ? [{ type: "text", text: part }] : [{ type: "image", assetId: part.image }])).reduce((list, node) => {
    const last = list.at(-1); if (node.type === "text" && last?.type === "text") list[list.length - 1] = { type: "text", text: last.text + node.text }; else list.push(node); return list;
  }, []);
  const base = nodes("原稿");
  assert.deepEqual(mergeDrafts(base, nodes("原稿"), nodes("原稿，另一页")), nodes("原稿，另一页"), "本页没有改动时取存储");
  assert.deepEqual(mergeDrafts(base, nodes("原稿，本页"), nodes("原稿")), nodes("原稿，本页"), "存储没有改动时取本页");
  assert.deepEqual(mergeDrafts(base, nodes("相同"), nodes("相同")), nodes("相同"), "两边相同时不重复");
  // 本页在末尾打字，另一页把取回的草稿放在开头（P0 的情形）：两份修改都在。
  assert.deepEqual(mergeDrafts(base, nodes("原稿", "，本页打字"), nodes("取回", { image: "a" }, "\n\n原稿")), nodes("取回", { image: "a" }, "\n\n原稿，本页打字"));
  // 本页放回（加在开头），另一页在末尾打字。
  assert.deepEqual(mergeDrafts(base, nodes("取回\n\n原稿"), nodes("原稿，另一页打字")), nodes("取回\n\n原稿，另一页打字"));
  // 本页提交（清空），另一页在末尾补充：保留另一页补充的部分，不重复已提交的原稿。
  assert.deepEqual(mergeDrafts(base, [], nodes("原稿，另一页补充")), nodes("，另一页补充"));
  // 另一页提交（清空），本页在末尾补充：只保留本页补充的部分。
  assert.deepEqual(mergeDrafts(base, nodes("原稿，本页补充"), []), nodes("，本页补充"));
  // 两页各放回一批（同一浏览器两页几乎同时领取不同记录）：两批都在。
  assert.deepEqual(mergeDrafts(base, nodes("甲批\n\n原稿"), nodes("乙批\n\n原稿")), nodes("甲批\n\n乙批\n\n原稿"));
  // 两边都改了中间：都保留，存储在前，空行分隔；原稿出现两次，宁可重复不丢失。
  assert.deepEqual(mergeDrafts(nodes("一二三"), nodes("一本页三"), nodes("一另一页三")), nodes("一另一页三\n\n一本页三"));
  assert.deepEqual(mergeDrafts([], nodes("本页"), nodes("另一页")), nodes("另一页\n\n本页"), "基准为空时两份都保留");
  assert.deepEqual(mergeDrafts([], nodes("本页"), []), nodes("本页"));
});

test("草稿比较后写入：版本未变时直接写入；另一页写过时合并而不覆盖；只在内容含两页修改时标记已合并", () => {
  const storage = new MemoryStorage();
  saveDraft(storage, "S", text("原稿"));
  const a = readDraft(storage, "S"); const b = readDraft(storage, "S");
  assert.deepEqual(a.nodes, text("原稿")); assert.equal(a.version, storage.getItem(draftKey("S")));
  // A 放回取回的草稿：版本未变，直接写入。
  const restored = commitDraft(storage, "S", prependDrafts([text("取回")], a.nodes), a.version);
  assert.equal(restored.merged, false); assert.deepEqual(loadDraft(storage, "S"), text("取回\n\n原稿"));
  // B 一直在打字（没有收到或忽略了 storage 事件），保存时基准仍是旧版本：合并，A 放回的草稿保留。
  const typed = commitDraft(storage, "S", text("原稿，B 打字"), b.version);
  assert.equal(typed.merged, true);
  assert.deepEqual(typed.nodes, text("取回\n\n原稿，B 打字"));
  assert.deepEqual(loadDraft(storage, "S"), typed.nodes); assert.equal(typed.version, storage.getItem(draftKey("S")));
  // A 随后以自己写入的版本为基准再保存：版本又变了，B 的内容同样不会丢。
  const again = commitDraft(storage, "S", text("取回\n\n原稿！"), restored.version);
  assert.equal(again.merged, true);
  assert.match(again.nodes[0].text, /取回/); assert.match(again.nodes.map((n) => n.text).join(""), /B 打字/);
  // 以最新版本为基准时直接写入，清空时删除键。
  const cleared = commitDraft(storage, "S", [], again.version);
  assert.equal(cleared.merged, false); assert.equal(cleared.version, null); assert.equal(storage.getItem(draftKey("S")), null);
  // 本页没有实际修改、另一页写过：取存储内容，不标记合并（调用方静默刷新输入框）。
  saveDraft(storage, "S", text("另一页"));
  const adopted = commitDraft(storage, "S", [], null);
  assert.deepEqual(adopted.nodes, text("另一页")); assert.equal(adopted.merged, false);
  // 写入失败时暂存在内存，版本取内存中的值，之后照常比较。
  storage.quota = 0;
  const memo = commitDraft(storage, "S", text("另一页，配额已满"), adopted.version);
  assert.equal(memo.merged, false); assert.deepEqual(loadDraft(storage, "S"), text("另一页，配额已满"));
  assert.equal(readDraft(storage, "S").version, memo.version);
  storage.quota = Infinity; saveDraft(storage, "S", []);
});
