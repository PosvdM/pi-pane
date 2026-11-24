import test from "node:test";
import assert from "node:assert/strict";
import {
  attachComposer, batchPrefix, deliverRestored, draftKey, loadDraft, loadNotice, saveDraft, saveNotice, takePending, unsavedSessions,
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

test("取回草稿：输入框已挂载时直接放回，未挂载时按会话保存为独立批次", () => {
  const storage = new MemoryStorage(); const received = [];
  const detach = attachComposer("A", (drafts) => received.push(drafts));
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
  const received = [];
  assert.equal(takePending(storage, "A", (drafts) => received.push(drafts)), true);
  assert.deepEqual(received, [[sure(text("C2")), unsure(image("u2")), sure(text("C1")), unsure(image("u1"))]]);
  assert.equal(received[0].filter((draft) => draft.uncertain).length, 2);
  assert.deepEqual(batchKeys(storage, "A"), [], "放回输入框后删除读到的记录");
  assert.equal(takePending(storage, "A", () => assert.fail("不得重复放回")), false);
});

test("R9-6 取回草稿：取走旧批期间写入的新批不被删除", () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", [sure(text("旧批"))]);
  const received = [];
  takePending(storage, "A", (drafts) => {
    received.push(drafts);
    // 另一标签页在输入框写入期间、删除记录之前存入新批。
    deliverRestored(storage, "A", [unsure(image("新"))]);
  });
  assert.deepEqual(received, [[sure(text("旧批"))]]);
  assert.equal(batchKeys(storage, "A").length, 1, "只删除本次读到的记录");
  takePending(storage, "A", (drafts) => received.push(drafts));
  assert.deepEqual(received[1], [unsure(image("新"))]);
});

test("取回草稿：输入框写入抛错时保留待放回记录，损坏的记录被清除", () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", [unsure(image("a"))]);
  assert.throws(() => takePending(storage, "A", () => { throw new Error("写入失败"); }), /写入失败/);
  assert.equal(batchKeys(storage, "A").length, 1);
  storage.setItem(batchPrefix("B") + "坏", "{坏");
  assert.equal(takePending(storage, "B", () => assert.fail("损坏的记录不应交给输入框")), false);
  assert.deepEqual(batchKeys(storage, "B"), []);
});

test("R9-1 取回草稿：localStorage 超出配额时草稿保存在内存并标记该会话，空间恢复后写回", () => {
  const storage = new MemoryStorage();
  storage.quota = 50;
  assert.equal(deliverRestored(storage, "满", [sure(text("很长的排队消息".repeat(10))), unsure(image("q"))]), "memory");
  assert.deepEqual(batchKeys(storage, "满"), []);
  assert.ok(unsavedSessions.get().has("满"), "该会话有只在内存中的记录");
  assert.equal(unsavedSessions.get().has("其他"), false);
  // 输入框挂载时仍能从内存取走，草稿保存同样失败时留在内存。
  const received = [];
  assert.equal(takePending(storage, "满", (drafts) => {
    received.push(drafts);
    assert.equal(saveDraft(storage, "满", drafts.flatMap((draft) => draft.nodes)), false);
    assert.equal(saveNotice(storage, "满", 1), true);
  }), true);
  assert.equal(received[0].length, 2);
  assert.equal(loadDraft(storage, "满").length, 3, "读取时内存记录优先");
  assert.equal(loadNotice(storage, "满"), 1);
  assert.ok(unsavedSessions.get().has("满"), "草稿仍只在内存中");
  storage.quota = Infinity;
  assert.equal(saveDraft(storage, "满", text("已发送一部分")), true);
  assert.equal(storage.getItem(draftKey("满")), JSON.stringify(text("已发送一部分")));
  assert.equal(unsavedSessions.get().has("满"), false, "写回后清除标记");
  assert.equal(saveNotice(storage, "满", 0), true);
  assert.equal(loadNotice(storage, "满"), 0);
});

test("取回草稿：注销旧输入框不影响同一会话新挂载的输入框", () => {
  const storage = new MemoryStorage(); const first = []; const second = [];
  const detachFirst = attachComposer("A", (drafts) => first.push(drafts));
  const detachSecond = attachComposer("A", (drafts) => second.push(drafts));
  detachFirst();
  assert.equal(deliverRestored(storage, "A", [sure(text("新"))]), "composer");
  assert.deepEqual([first.length, second.length], [0, 1]);
  detachSecond();
});
