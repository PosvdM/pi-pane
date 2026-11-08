import test from "node:test";
import assert from "node:assert/strict";
import { claim, emptyMirror, match, reconcile } from "../packages/server/dist/queue-mirror.js";

const image = (id) => [{ type: "text", text: "T" }, { type: "image", assetId: id }];

test("队列镜像：新增在队尾，消费删除同文字的最早项", () => {
  let items = reconcile([], ["T"]);
  assert.ok(claim([], items, image("a")));
  const first = items[0];
  items = reconcile(items, ["T", "T"]);
  assert.equal(items[0], first);
  assert.ok(claim([first], items, image("b")));
  // pi 开始处理第一条 T：剩下的是第二条（图片 b）。
  items = reconcile(items, ["T"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].draft[1].assetId, "b");
});

test("队列镜像：已消费的草稿不会被后来的同文字队列项取回", () => {
  let items = reconcile([], ["T"]);
  claim([], items, image("a"));
  items = reconcile(items, []);
  const before = items;
  items = reconcile(items, ["T"]);
  claim(before, items, image("b"));
  const [restored] = match(items, ["T"]);
  assert.equal(restored.draft[1].assetId, "b");
});

test("队列镜像：扩展先追加的消息不被当前输入认领，handled 时调用方不认领", () => {
  const before = reconcile([], ["E0"]);
  const after = reconcile(before, ["E0", "辅助", "T"]);
  assert.ok(claim(before, after, image("a")));
  assert.equal(after[1].draft, undefined);
  assert.equal(after[2].draft[1].assetId, "a");
});

test("队列镜像：清出的文字对应快照后缀，种类分开", () => {
  const mirror = emptyMirror();
  mirror.followUp = reconcile([], ["T"]); claim([], mirror.followUp, image("f"));
  mirror.steering = reconcile([], ["T"]); claim([], mirror.steering, image("s"));
  const items = [...match(mirror.steering, ["T"]), ...match(mirror.followUp, ["T"])];
  assert.deepEqual(items.map((item) => item.draft[1].assetId), ["s", "f"]);
  // 快照与清出之间队首被消费：清出的文字仍对应快照的后缀。
  const queue = reconcile([], ["A", "B"]); claim([queue[0]], queue, image("b"));
  assert.equal(match(queue, ["B"])[0].draft[1].assetId, "b");
  assert.equal(match(queue, ["X"])[0], undefined);
});
