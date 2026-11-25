import test from "node:test";
import assert from "node:assert/strict";
import { prependDrafts } from "../packages/web/src/lib/draft.ts";
import {
  ADOPT_SETTLE_MS, FLIGHT_GRACE_MS, FLIGHT_STALE_MS, addNotice, adoptDrafts, attachComposer, batchPrefix, beginSubmit, clearNotice, deliverRestored, draftKey, draftPrefix, encodeId,
  finishSubmit, flightPrefix, FLIGHT_HELD_RECHECK_MS, legacyDraftKey, legacyLock, loadDraft, loadNotice, noticeKey, recoverFlights, saveDraft, takePending, unsavedSessions, watchOwner,
} from "../packages/web/src/lib/restored.ts";
import { tabLock } from "../packages/web/src/lib/tab.ts";

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
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const T4 = "44444444-4444-4444-8444-444444444444";
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
    assert.equal(saveDraft(storage, "满", T1, drafts.flatMap((draft) => draft.nodes)), false);
  });
  const detach = attachComposer("满", full.handle);
  assert.equal(takePending(storage, "满"), true);
  detach();
  assert.equal(full.received[0].length, 2);
  assert.deepEqual(loadDraft(storage, "满", T1), [{ type: "text", text: "很长的排队消息".repeat(10) + "图 " }, { type: "image", assetId: "q" }], "读取时内存记录优先");
  assert.ok(unsavedSessions.get().has("满"), "草稿仍只在内存中");
  storage.quota = Infinity;
  assert.equal(saveDraft(storage, "满", T1, text("已发送一部分")), true);
  assert.equal(storage.getItem(draftKey("满", T1)), JSON.stringify(text("已发送一部分")));
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

/** 模拟输入框的收养：收养的内容在前、本页内容在后，写入本页的键。 */
function adopter(storage, sessionId, tabId, initial = [], locks = null) {
  const box = { content: initial, adopted: [], attached: true };
  box.absorb = (nodes, legacy) => {
    if (!box.attached) return undefined;
    box.adopted.push({ nodes, legacy });
    box.content = prependDrafts([nodes], box.content);
    return saveDraft(storage, sessionId, tabId, box.content, locks);
  };
  return box;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("草稿按标签页分键：每页只读写自己的键，保存直接写入、空草稿删除；会话 id 编码后作前缀，与旧版共用键不会相同", () => {
  const storage = new MemoryStorage();
  assert.equal(draftKey("S", T1), `pi-pane.tabdraft.S.${T1}`);
  assert.equal(draftPrefix("a.b"), "pi-pane.tabdraft.a%002eb.", "会话 id 中的“.”编码，前缀不会与其他会话混淆");
  assert.notEqual(legacyDraftKey(`A.${T1}`), draftKey("A", T1), "会话 id 形如 A.<tabId> 的旧键不是会话 A 的新键");
  assert.ok(!legacyDraftKey(`tab.${T1}`).startsWith(draftPrefix("tab")) && !draftKey("x", T1).startsWith("pi-pane.draft."), "新旧两种键前缀不同");
  assert.equal(saveDraft(storage, "S", T1, text("甲页"), null), true);
  assert.equal(saveDraft(storage, "S", T2, text("乙页"), null), true);
  assert.deepEqual(loadDraft(storage, "S", T1), text("甲页"));
  assert.deepEqual(loadDraft(storage, "S", T2), text("乙页"), "两页各写各的，互不覆盖");
  saveDraft(storage, "S", T1, [{ type: "text", text: "  " }], null);
  assert.equal(storage.getItem(draftKey("S", T1)), null);
  assert.deepEqual(loadDraft(storage, "S", T2), text("乙页"));
  assert.deepEqual(loadDraft(storage, "S", T3), []);
});

test("收养：锁被持有（标签页仍打开）时跳过并返回它的 tabId；取得锁时把它的草稿放在本页内容之前，先写入本页的键再删除原键", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  saveDraft(storage, "S", T2, text("仍打开的乙页"), null);
  saveDraft(storage, "S", T3, [...text("已关闭的丙页 "), ...image("c").slice(1)], null);
  saveDraft(storage, "其他", T3, text("其他会话"), null);
  saveDraft(storage, "S", T1, text("本页"), null);
  locks.held.add(tabLock(T2));
  const box = adopter(storage, "S", T1, text("本页"), locks);
  // 写入本页的键时原键必须仍在：先写后删。
  const absorb = box.absorb;
  box.absorb = (nodes, legacy) => { assert.notEqual(storage.getItem(draftKey("S", T3)), null, "写入本页之前不删除原键"); return absorb(nodes, legacy); };
  assert.deepEqual(await adoptDrafts(storage, "S", T1, box.absorb, locks), [T2], "返回仍开着的标签页，供调用方等它关闭");
  assert.deepEqual(box.adopted, [{ nodes: [{ type: "text", text: "已关闭的丙页 " }, { type: "image", assetId: "c" }], legacy: false }]);
  assert.deepEqual(loadDraft(storage, "S", T1), prependDrafts([[{ type: "text", text: "已关闭的丙页 " }, { type: "image", assetId: "c" }]], text("本页")));
  assert.equal(storage.getItem(draftKey("S", T3)), null, "收养后删除原键");
  assert.deepEqual(loadDraft(storage, "S", T2), text("仍打开的乙页"), "仍打开的标签页不收养");
  assert.deepEqual(loadDraft(storage, "其他", T3), text("其他会话"), "只收养本会话的键");
  assert.ok(!locks.requested.includes(tabLock(T1)), "不收养本页自己的键");
});

test("收养：锁内重新读取，已被其他标签页收养走的不再收养；输入框已切换会话时不收养、不删除", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  saveDraft(storage, "S", T3, text("丙页"), null);
  // 取得锁之前另一个标签页已收养并删除。
  const request = locks.request;
  locks.request = async (name, options, callback) => { storage.removeItem(draftKey("S", T3)); return request(name, options, callback); };
  const box = adopter(storage, "S", T1, [], locks);
  assert.deepEqual(await adoptDrafts(storage, "S", T1, box.absorb, locks), []);
  assert.deepEqual(box.adopted, []);
  locks.request = request;
  saveDraft(storage, "S", T3, text("丙页"), null);
  box.attached = false;
  await adoptDrafts(storage, "S", T1, box.absorb, locks);
  assert.deepEqual(loadDraft(storage, "S", T3), text("丙页"), "没有收养时原键保留");
});

test("收养：本页写入失败时不删除原键，内容留在本页内存；再次扫描不重复收养，之后本页写入成功时在原主的锁内删除原键", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  saveDraft(storage, "Q", T3, text("丙页的长草稿".repeat(5)), null);
  storage.quota = [...storage.items].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const box = adopter(storage, "Q", T1, [], locks);
  await adoptDrafts(storage, "Q", T1, box.absorb, locks);
  assert.equal(box.adopted.length, 1);
  assert.notEqual(storage.getItem(draftKey("Q", T3)), null, "写入失败时保留原键");
  assert.deepEqual(loadDraft(storage, "Q", T1), text("丙页的长草稿".repeat(5)), "内容在本页内存中");
  assert.ok(unsavedSessions.get().has("Q"), "照写入失败处理：提示并在离开页面前确认");
  await adoptDrafts(storage, "Q", T1, box.absorb, locks);
  assert.equal(box.adopted.length, 1, "同一内容不重复收养");
  storage.quota = Infinity;
  locks.requested.length = 0;
  assert.equal(saveDraft(storage, "Q", T1, box.content, locks), true);
  await tick();
  assert.ok(locks.requested.includes(tabLock(T3)), "删除原键时取原主的锁");
  assert.equal(storage.getItem(draftKey("Q", T3)), null, "本页写入成功后删除原键");
  assert.equal(unsavedSessions.get().has("Q"), false);
  saveDraft(storage, "Q", T1, [], null);
});

test("收养后延迟删除原键：原主的锁被持有（刷新后的页面沿用了这个 tabId）时不删，锁释放后再删；原键的值变化时不删，按新内容重新收养", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  const fill = (id, value) => { saveDraft(storage, id, T3, text(value), null); storage.quota = [...storage.items].reduce((n, [k, v]) => n + k.length + v.length, 0); };
  // 锁被持有：不删，留到下次写入成功时再试。
  fill("R", "丙页的草稿".repeat(5));
  const box = adopter(storage, "R", T1, [], locks);
  await adoptDrafts(storage, "R", T1, box.absorb, locks);
  storage.quota = Infinity;
  locks.held.add(tabLock(T3));
  saveDraft(storage, "R", T1, box.content, locks); await tick();
  assert.notEqual(storage.getItem(draftKey("R", T3)), null, "原主的锁被持有时不删除");
  locks.held.delete(tabLock(T3));
  saveDraft(storage, "R", T1, box.content, locks); await tick();
  assert.equal(storage.getItem(draftKey("R", T3)), null, "锁释放后下次写入成功时删除");
  saveDraft(storage, "R", T1, [], null);

  // 值变化：原主在收养之后写入了新内容，不删，之后的收养按新内容处理。
  fill("P", "旧的丙页草稿".repeat(5));
  const other = adopter(storage, "P", T1, [], locks);
  await adoptDrafts(storage, "P", T1, other.absorb, locks);
  storage.quota = Infinity;
  storage.setItem(draftKey("P", T3), JSON.stringify(text("丙页的新内容")));
  saveDraft(storage, "P", T1, other.content, locks); await tick();
  assert.deepEqual(loadDraft(storage, "P", T3), text("丙页的新内容"), "值已变化时不删除");
  await adoptDrafts(storage, "P", T1, other.absorb, locks);
  assert.deepEqual(other.adopted.at(-1), { nodes: text("丙页的新内容"), legacy: false }, "新内容照常收养");
  assert.equal(storage.getItem(draftKey("P", T3)), null);
  saveDraft(storage, "P", T1, [], null);
});

test("收养：旧版没有 tabId 的共用键当作没有主人的键，在锁内收养；其他会话的旧键和不像 tabId 的键不动", async () => {
  const storage = new MemoryStorage(); const locks = fakeLocks();
  storage.setItem(legacyDraftKey("S"), JSON.stringify(text("升级前的草稿")));
  storage.setItem(legacyDraftKey(`S.${T2}`), JSON.stringify(text("另一会话的旧草稿")));
  const box = adopter(storage, "S", T1, text("本页"), locks);
  await adoptDrafts(storage, "S", T1, box.absorb, locks);
  assert.deepEqual(box.adopted, [{ nodes: text("升级前的草稿"), legacy: true }]);
  assert.ok(locks.requested.includes(legacyLock("S")));
  assert.ok(!locks.requested.includes(tabLock(T2)), "会话 S.<tabId> 的旧键不被当作会话 S 中某个标签页的键");
  assert.deepEqual(loadDraft(storage, "S", T1), text("升级前的草稿\n\n本页"));
  assert.equal(storage.getItem(legacyDraftKey("S")), null);
  assert.notEqual(storage.getItem(legacyDraftKey(`S.${T2}`)), null);
  // 损坏或空的键直接删除，不放进输入框。
  storage.setItem(draftKey("S", T2), "{坏");
  await adoptDrafts(storage, "S", T1, box.absorb, locks);
  assert.equal(box.adopted.length, 1);
  assert.equal(storage.getItem(draftKey("S", T2)), null);
});

test("收养：没有 Web Locks 时无法判断标签页是否已关闭，不收养任何键，原键全部保留", async () => {
  const storage = new MemoryStorage();
  saveDraft(storage, "S", T2, text("乙页"), null);
  storage.setItem(legacyDraftKey("S"), JSON.stringify(text("旧版")));
  const box = adopter(storage, "S", T1);
  assert.deepEqual(await adoptDrafts(storage, "S", T1, box.absorb, null), []);
  assert.deepEqual(box.adopted, []);
  assert.deepEqual(loadDraft(storage, "S", T2), text("乙页"));
  assert.notEqual(storage.getItem(legacyDraftKey("S")), null);
});

test("等待仍开着的标签页关闭：它的锁释放后立即调用并释放锁（不挡住刷新后的页面重新取锁）；卸载时撤销等待", async () => {
  // 支持排队等待的替身锁：held 中的锁被其他页面持有，release 释放并交给下一个等待者。
  const held = new Set(); const waiters = new Map();
  const locks = {
    async request(name, options, callback) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise((resolve, reject) => {
          const queue = waiters.get(name) ?? []; waiters.set(name, queue); queue.push(resolve);
          options.signal?.addEventListener("abort", () => { queue.splice(queue.indexOf(resolve), 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
        });
      }
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); waiters.get(name)?.shift()?.(); }
    },
  };
  held.add(tabLock(T2)); held.add(tabLock(T3));
  const closed = []; const stop = new AbortController();
  watchOwner(locks, T2, stop.signal, () => closed.push(T2));
  watchOwner(locks, T3, stop.signal, () => closed.push(T3));
  await tick();
  assert.deepEqual(closed, []);
  held.delete(tabLock(T2)); waiters.get(tabLock(T2)).shift()();
  await tick();
  assert.deepEqual(closed, [T2]);
  assert.equal(held.has(tabLock(T2)), false, "取得后立即释放");
  stop.abort();
  held.delete(tabLock(T3)); waiters.get(tabLock(T3))?.shift()?.();
  await tick();
  assert.deepEqual(closed, [T2], "撤销后不再调用");
  assert.ok(ADOPT_SETTLE_MS >= 2000, "等到锁释放后再等一段时间才收养，刷新中的页面能先重新取得锁");
});
