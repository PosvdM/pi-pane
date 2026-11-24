import test from "node:test";
import assert from "node:assert/strict";
import { attachComposer, deliverRestored, pendingKey, readPending, takePending } from "../packages/web/src/lib/restored.ts";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
  get size() { return this.#items.size; }
}
const text = (value) => [{ type: "text", text: value }];
const image = (id) => [{ type: "text", text: "图 " }, { type: "image", assetId: id }];

test("取回草稿：输入框已挂载时直接放回，未挂载时按会话保存", () => {
  const storage = new MemoryStorage(); const received = [];
  const detach = attachComposer(storage, "A", (restored) => received.push(restored));
  assert.equal(deliverRestored(storage, "A", { drafts: [text("一"), image("a")], uncertain: 1 }), "composer");
  assert.deepEqual(received, [{ drafts: [text("一"), image("a")], uncertain: 1 }]);
  // 其他会话的结果不进入 A 的输入框。
  assert.equal(deliverRestored(storage, "B", { drafts: [text("乙")], uncertain: 0 }), "stored");
  assert.equal(received.length, 1);
  assert.deepEqual(readPending(storage, "B"), { drafts: [text("乙")], uncertain: 0 });
  detach();
  assert.equal(deliverRestored(storage, "A", { drafts: [text("二")], uncertain: 0 }), "stored");
  assert.equal(received.length, 1);
  assert.equal(deliverRestored(storage, "A", { drafts: [[{ type: "text", text: " " }]], uncertain: 0 }), "none");
});

test("取回草稿：多批待放回记录合并，后清出的在前，输入框挂载时一次取走", () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", { drafts: [text("第一批"), image("u1")], uncertain: 1 });
  deliverRestored(storage, "A", { drafts: [text("第二批")], uncertain: 0 });
  assert.deepEqual(readPending(storage, "A"), { drafts: [text("第二批"), text("第一批"), image("u1")], uncertain: 1 });
  const received = [];
  const detach = attachComposer(storage, "A", (restored) => received.push(restored));
  assert.deepEqual(received, [{ drafts: [text("第二批"), text("第一批"), image("u1")], uncertain: 1 }]);
  assert.equal(storage.getItem(pendingKey("A")), null, "放回输入框后删除待放回记录");
  detach();
  // 再次挂载不会重复放回。
  attachComposer(storage, "A", (restored) => received.push(restored))();
  assert.equal(received.length, 1);
});

test("取回草稿：输入框写入失败时保留待放回记录，损坏的记录被清除", () => {
  const storage = new MemoryStorage();
  deliverRestored(storage, "A", { drafts: [image("a")], uncertain: 1 });
  assert.throws(() => takePending(storage, "A", () => { throw new Error("写入失败"); }), /写入失败/);
  assert.deepEqual(readPending(storage, "A"), { drafts: [image("a")], uncertain: 1 });
  storage.setItem(pendingKey("B"), "{坏");
  assert.equal(takePending(storage, "B", () => assert.fail("损坏的记录不应交给输入框")), false);
  assert.equal(storage.getItem(pendingKey("B")), null);
});

test("取回草稿：注销旧输入框不影响同一会话新挂载的输入框", () => {
  const storage = new MemoryStorage(); const first = []; const second = [];
  const detachFirst = attachComposer(storage, "A", (restored) => first.push(restored));
  const detachSecond = attachComposer(storage, "A", (restored) => second.push(restored));
  detachFirst();
  assert.equal(deliverRestored(storage, "A", { drafts: [text("新")], uncertain: 0 }), "composer");
  assert.deepEqual([first.length, second.length], [0, 1]);
  detachSecond();
});
