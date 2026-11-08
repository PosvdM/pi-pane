import test from "node:test";
import assert from "node:assert/strict";
import { claim, emptyMirror, reconcile, removed, restore } from "../packages/server/dist/queue-mirror.js";

const image = (id) => [{ type: "text", text: "T" }, { type: "image", assetId: id }];
const asset = (claimed) => claimed?.draft[1].assetId;

test("队列镜像：新增在队尾，消费删除同文字的最早项", () => {
  let items = reconcile([], ["T"]);
  assert.ok(claim([], items, image("a")));
  const first = items[0];
  items = reconcile(items, ["T", "T"]);
  assert.equal(items[0], first);
  assert.ok(claim([first], items, image("b")));
  // pi 开始处理第一条 T：剩下的是第二条（图片 b），第一条作为已移除项释放。
  const next = reconcile(items, ["T"]);
  assert.deepEqual(removed(items, next), [first]);
  assert.equal(asset(next[0].claim), "b");
});

test("队列镜像：已消费的草稿不会被后来的同文字队列项取回", () => {
  let items = reconcile([], ["T"]);
  claim([], items, image("a"));
  items = reconcile(items, []);
  const before = items;
  items = reconcile(items, ["T"]);
  claim(before, items, image("b"));
  assert.equal(asset(restore(items, ["T"]).certain[0]), "b");
});

test("队列镜像：文字或图片标记相符的唯一新增项直接认领", () => {
  const key = "看图⟦pane-img:abc123:1⟧";
  const before = reconcile([], ["E0"]);
  const after = reconcile(before, ["E0", "辅助", "改写后⟦pane-img:abc123:1⟧"]);
  assert.ok(claim(before, after, image("a"), key));
  assert.equal(after[1].claim, undefined);
  assert.equal(asset(after[2].claim), "a");
});

test("队列镜像：归属不明的草稿交给用户确认", () => {
  const after = reconcile([], ["T", "辅助"]);
  claim([], after, image("a"), "/模板 ⟦pane-img:xyz789:1⟧");
  // 归属不明的草稿不占用任何候选位置，交给用户确认；部分候选已消费时同样交出，不丢弃。
  for (const texts of [["T", "辅助"], ["辅助"]]) {
    const result = restore(after, texts);
    assert.ok(result.certain.every((item) => item === undefined));
    assert.deepEqual(result.uncertain.map(asset), ["a"]);
  }
});

test("队列镜像：清出的文字对应快照后缀，种类分开", () => {
  const mirror = emptyMirror();
  mirror.followUp = reconcile([], ["T"]); claim([], mirror.followUp, image("f"));
  mirror.steering = reconcile([], ["T"]); claim([], mirror.steering, image("s"));
  const items = [...restore(mirror.steering, ["T"]).certain, ...restore(mirror.followUp, ["T"]).certain];
  assert.deepEqual(items.map(asset), ["s", "f"]);
  const queue = reconcile([], ["A", "B"]); claim([queue[0]], queue, image("b"));
  assert.equal(asset(restore(queue, ["B"]).certain[0]), "b");
  assert.equal(restore(queue, ["X"]).certain[0], undefined);
});
