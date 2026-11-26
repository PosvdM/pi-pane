// 浏览器会话树的同步路径（packages/web/src/lib/tree.ts）：直接调用生产代码处理订阅推来的变更。
// tree.ts 依赖的模块在加载时注册浏览器事件，先提供空实现；取快照的请求挂起，不影响断言。
import test from "node:test";
import assert from "node:assert/strict";

globalThis.addEventListener ??= () => {};
globalThis.fetch = () => new Promise(() => {});
const { awaitingParent, onChange, trees } = await import("../packages/web/src/lib/tree.ts");
const { SourceTree } = await import("../packages/web/src/lib/tree-state.ts");

const node = (id, parentId) => ({ id, source: "a", kind: "session", parentId, title: id, status: "running", availability: "online",
  hasChildren: false, sortKey: id, revision: 1, capabilities: [] });

test("补取父节点名额已满时，remove 去掉某父节点的最后一个引用，腾出的名额立即用于此前没有申请的父节点", () => {
  // 每个来源最多补取 800 个父节点（TreePins 的默认名额）。a 的 801 个节点各挂在一个未加载的主会话下。
  const pane = new SourceTree("pane"); pane.load({ source: "pane", epoch: "e", revision: 1, nodes: [] });
  const a = new SourceTree("a");
  a.load({ source: "a", epoch: "e", revision: 1, nodes: Array.from({ length: 801 }, (_, i) => node(`a:${i}`, `pane:session:${i}`)) });
  trees.get().set("pane", pane); trees.get().set("a", a);
  // 任一变更触发扫描：前 800 个父节点申请补取，第 801 个超出名额。
  onChange("a", { type: "upsert", revision: 2, node: { ...node("a:0", "pane:session:0"), title: "改名" } });
  assert.equal(awaitingParent("pane:session:799"), true);
  assert.equal(awaitingParent("pane:session:800"), false);
  // 删除 pane:session:1 下唯一的节点：同一次处理里重新扫描，名额给 pane:session:800。
  onChange("a", { type: "remove", revision: 3, id: "a:1" });
  assert.equal(awaitingParent("pane:session:800"), true, "remove 之后应重新扫描补取");
});
