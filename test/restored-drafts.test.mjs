import test from "node:test";
import assert from "node:assert/strict";
import { prependDrafts } from "../packages/web/src/lib/draft.ts";
import {
  attachComposer, batchPrefix, clearSubmitted, deliverRestored, draftKey, loadDraft, loadUncertain, releaseWatch, remainingUncertain,
  saveDraft, saveUncertain, takePending, unsavedSessions, watchRestored,
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
/** 模拟输入框：deliver 把草稿放在现有内容之前，received 记录每次放回的草稿。 */
function composer(onDeliver) {
  const box = { content: [], received: [] };
  box.handle = {
    deliver: (drafts) => { onDeliver?.(drafts); box.received.push(drafts); box.content = prependDrafts(drafts.map((d) => d.nodes), box.content); },
    read: () => box.content,
    write: (nodes) => { box.content = nodes; },
  };
  return box;
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
    assert.equal(saveUncertain(storage, "满", [image("q")]), false);
  });
  const detach = attachComposer("满", full.handle);
  assert.equal(takePending(storage, "满"), true);
  detach();
  assert.equal(full.received[0].length, 2);
  assert.equal(loadDraft(storage, "满").length, 3, "读取时内存记录优先");
  assert.deepEqual(loadUncertain(storage, "满"), [image("q")]);
  assert.ok(unsavedSessions.get().has("满"), "草稿仍只在内存中");
  storage.quota = Infinity;
  assert.equal(saveDraft(storage, "满", text("已发送一部分")), true);
  assert.equal(storage.getItem(draftKey("满")), JSON.stringify(text("已发送一部分")));
  assert.ok(unsavedSessions.get().has("满"), "归属不明记录仍只在内存中");
  assert.equal(saveUncertain(storage, "满", [image("q")]), true);
  assert.equal(storage.getItem("pi-pane.uncertain.满"), JSON.stringify([image("q")]));
  assert.equal(unsavedSessions.get().has("满"), false, "全部写回后清除标记");
  assert.equal(saveUncertain(storage, "满", []), true);
  assert.deepEqual(loadUncertain(storage, "满"), []);
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

test("归属不明提示：只计入输入框中仍原样保留的归属不明草稿", () => {
  const u1 = image("u1"); const u2 = [{ type: "text", text: "纯文本归属不明\n" }];
  const content = prependDrafts([text("确定"), u1, u2], text("现有"));
  assert.deepEqual(remainingUncertain(content, [u1, u2]), [u1, u2], "首尾空白不影响比较");
  // 只删除其中一条，保留其他内容。
  const withoutU1 = prependDrafts([text("确定"), u2], text("现有"));
  assert.deepEqual(remainingUncertain(withoutU1, [u1, u2]), [u2]);
  // 改动过的条目视为已处理。
  const edited = prependDrafts([text("确定"), [{ type: "text", text: "图 改过 " }, { type: "image", assetId: "u1" }]], []);
  assert.deepEqual(remainingUncertain(edited, [u1]), []);
  // 内容相同的两条按出现次数计。
  assert.deepEqual(remainingUncertain(prependDrafts([u1], []), [u1, u1]), [u1]);
  assert.deepEqual(remainingUncertain(prependDrafts([u1, u1], []), [u1, u1]), [u1, u1]);
  assert.deepEqual(remainingUncertain([], [u1]), []);
});

test("提交清理：只删除已提交的内容，保留等待期间放回的草稿，切到其他会话后改保存的草稿", () => {
  const storage = new MemoryStorage();
  const quit = text("/quit");
  // 输入框挂载：等待期间放回的草稿在已提交内容之前。
  const a = composer(); a.content = quit; const detachA = attachComposer("A", a.handle);
  const watch = watchRestored("A"); const other = watchRestored("B");
  deliverRestored(storage, "A", [sure(text("取回一"))]);
  deliverRestored(storage, "B", [sure(text("属于 B"))]);
  assert.deepEqual(other.restored, [], "其他会话的放回不计入");
  assert.equal(clearSubmitted(storage, watch, quit), true);
  assert.deepEqual(a.content, text("取回一"));
  releaseWatch(other);
  detachA();

  // 切到其他会话后输入框已卸载：从保存的草稿中删除，等待期间存入的待放回记录不受影响。
  saveDraft(storage, "A", quit);
  const away = watchRestored("A");
  deliverRestored(storage, "A", [sure(text("取回二"))]);
  assert.equal(clearSubmitted(storage, away, quit), true);
  assert.equal(storage.getItem(draftKey("A")), null);
  assert.equal(batchKeys(storage, "A").length, 1);

  // 离开时输入框已含放回的草稿并保存。
  saveDraft(storage, "A", prependDrafts([text("取回三")], quit));
  const saved = watchRestored("A");
  const b = composer(); b.content = quit; const detachB = attachComposer("A", b.handle);
  deliverRestored(storage, "A", [sure(text("取回三"))]);
  detachB();
  assert.equal(clearSubmitted(storage, saved, quit), true);
  assert.deepEqual(loadDraft(storage, "A"), text("取回三"));

  // 等待期间用户编辑过：不改动。
  saveDraft(storage, "A", text("/quit 之后又写了字"));
  assert.equal(clearSubmitted(storage, watchRestored("A"), quit), false);
  assert.deepEqual(loadDraft(storage, "A"), text("/quit 之后又写了字"));
});

test("提交清理：提交结束后注销记录，之后的放回不再保留在内存中", () => {
  const storage = new MemoryStorage();
  const a = composer(); const detach = attachComposer("A", a.handle);
  const watch = watchRestored("A");
  deliverRestored(storage, "A", [sure(text("一"))]);
  assert.equal(watch.restored.length, 1);
  releaseWatch(watch);
  assert.deepEqual(watch.restored, [], "注销时释放已记录的草稿");
  deliverRestored(storage, "A", [sure(text("二"))]);
  assert.deepEqual(watch.restored, [], "注销后不再记录");
  detach();
});
