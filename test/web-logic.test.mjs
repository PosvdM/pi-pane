import test from "node:test";
import assert from "node:assert/strict";
import { fromSnapshot, apply, prependHistory, keepLoadedHistory } from "../packages/web/src/lib/session-model.ts";
import { normalize, plainText, prependDrafts, displayQueued, parseSlash, isEmpty, imageIds } from "../packages/web/src/lib/draft.ts";
import { canonicalize, JcsError } from "../packages/web/src/lib/jcs.ts";
import { SourceTree, TreePins, MAX_OPEN_NODE_IDS, isHot, childrenAcross, hiddenChildren, missingParents, orphanHistory, unassigned } from "../packages/web/src/lib/tree-state.ts";
import { addNotificationTo, clampSidebar, restoreText, sortBanners, splitActions, visibleBanners } from "../packages/web/src/lib/plugin-state.ts";
import { SessionModel } from "../packages/server/dist/model.js";
import { NUMBER_VECTORS, hexToDouble, SAMPLE_INPUT, SAMPLE_OUTPUT, SORT_INPUT, SORT_EXPECTED_OUTPUT } from "./fixtures/jcs-vectors.mjs";

const ref = { source: "pane", id: "测试会话" };
const text = value => ({ type: "text", text: value });
const image = assetId => ({ type: "image", assetId });
const message = value => ({ role: "assistant", timestamp: 1234, content: [text(value)] });
const entry = (id, value = id) => ({ type: "message", id, parentId: null, message: message(value) });
function snapshot() {
  return {
    ref, cursor: { epoch: "epoch", seq: 10 }, entries: [entry("当前")], leafId: "当前", historyBefore: "当前",
    status: "idle", controlRevision: 2, readonly: true,
    inFlight: { phase: "idle", tools: [], queue: { steering: [], followUp: [] } },
  };
}
function receive(state, event) {
  assert.equal(apply(state, { ref, cursor: { epoch: state.view.cursor.epoch, seq: state.view.cursor.seq + 1 }, event }), "applied");
}

test("会话快照与游标：连续、重复、跳号、epoch 和 resync", () => {
  const initial = snapshot(); const state = fromSnapshot(initial);
  assert.deepEqual(state.view, initial); assert.notEqual(state.view, initial);
  assert.deepEqual(state.entries, initial.entries); assert.equal(state.version, 0);
  receive(state, { type: "queue_update", steering: ["一次"], followUp: [] });
  assert.equal(initial.cursor.seq, 10); assert.equal(state.view.cursor.seq, 11); assert.equal(state.version, 1);
  const saved = structuredClone(state);
  for (const [cursor, event, expected] of [
    [{ epoch: "epoch", seq: 11 }, { type: "queue_update", steering: ["重复"] }, "duplicate"],
    [{ epoch: "epoch", seq: 9 }, { type: "queue_update" }, "duplicate"],
    [{ epoch: "epoch", seq: 13 }, { type: "queue_update" }, "resync"],
    [{ epoch: "其他", seq: 12 }, { type: "queue_update" }, "resync"],
    [{ epoch: "epoch", seq: 12 }, { type: "resync" }, "resync"],
  ]) {
    assert.equal(apply(state, { ref, cursor, event }), expected);
    assert.deepEqual(state, saved, "拒绝和重复的事件不能改变模型");
  }
});

test("文本、思考与工具调用逐事件重建，与服务端 blocks 一致", () => {
  const server = new SessionModel(ref, { detach: value => value });
  const state = fromSnapshot(server.snapshot());
  const start = { type: "message_start", message: message("") };
  server.apply(start); receive(state, start);
  assert.deepEqual(state.view.inFlight.assistant.blocks, []);
  const deltas = [
    { type: "thinking_start", contentIndex: 1 },
    { type: "thinking_delta", contentIndex: 1, delta: "思考" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "你" },
    { type: "text_delta", contentIndex: 0, delta: "好" },
    { type: "text_end", contentIndex: 0, content: "你好！" },
    { type: "thinking_end", contentIndex: 1, content: "思考完成" },
    { type: "toolcall_start", contentIndex: 2 },
    { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' },
    { type: "toolcall_delta", contentIndex: 2, delta: '"文件"}' },
    { type: "toolcall_end", contentIndex: 2, toolCall: { id: "工具一", name: "read", arguments: { path: "文件" } } },
  ];
  for (const delta of deltas) {
    const event = { type: "message_update", message: { timestamp: 1234, usage: { input: 7 } }, assistantMessageEvent: delta };
    server.apply(event); receive(state, event);
    assert.deepEqual(state.view.inFlight.assistant.blocks, server.inFlight.assistant.blocks, delta.type);
  }
  assert.deepEqual(state.view.inFlight.assistant.blocks, [
    { type: "text", contentIndex: 0, text: "你好！", done: true },
    { type: "thinking", contentIndex: 1, text: "思考完成", done: true },
    { type: "toolCall", contentIndex: 2, id: "工具一", toolName: "read", argsText: '{"path":"文件"}', args: { path: "文件" }, done: true },
  ]);
  assert.deepEqual(state.view.inFlight.assistant.usage, { input: 7 });
  // 同一 contentIndex 的新起点替换旧块，不产生重复。
  const restart = { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } };
  server.apply(restart); receive(state, restart);
  assert.deepEqual(state.view.inFlight.assistant.blocks, server.inFlight.assistant.blocks);
});

test("message_end 暂存完整消息，pane_entries 只移除内容匹配的 completed", () => {
  const state = fromSnapshot(snapshot());
  receive(state, { type: "message_start", message: message("") });
  const first = message("先完成"); const later = message("后完成");
  receive(state, { type: "message_end", message: first });
  receive(state, { type: "message_end", message: later });
  assert.equal(state.view.inFlight.assistant, undefined);
  assert.deepEqual(state.view.inFlight.completed, [first, later]);
  const fresh = { ...entry("新条目"), message: structuredClone(first) };
  receive(state, { type: "pane_entries", entries: [entry("当前"), fresh], leafId: fresh.id });
  assert.deepEqual(state.entries.map(e => e.id), ["当前", "新条目"]);
  assert.equal(state.view.leafId, "新条目");
  assert.deepEqual(state.view.inFlight.completed, [later]);
  receive(state, { type: "pane_entries", entries: [fresh], leafId: fresh.id });
  assert.equal(state.entries.length, 2); assert.deepEqual(state.view.inFlight.completed, [later]);
});

test("状态、队列与工具执行的事件投影", () => {
  const state = fromSnapshot(snapshot());
  receive(state, { type: "pane_status", status: "running", phase: "tools", controlRevision: 9, readonly: false, detail: "运行中" });
  assert.equal(state.view.status, "running"); assert.equal(state.view.controlRevision, 9);
  assert.equal(state.view.inFlight.phase, "tools"); assert.equal(state.view.readonly, false); assert.equal(state.detail, "运行中");
  receive(state, { type: "queue_update", steering: ["引导"], followUp: ["跟进"] });
  assert.deepEqual(state.view.inFlight.queue, { steering: ["引导"], followUp: ["跟进"] });
  receive(state, { type: "queue_update" });
  assert.deepEqual(state.view.inFlight.queue, { steering: [], followUp: [] });
  receive(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "一" } });
  receive(state, { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "二" } });
  assert.equal(state.view.inFlight.tools.length, 2);
  assert.deepEqual(state.view.inFlight.tools[0].args, { path: "一" });
  assert.equal(state.view.inFlight.tools[0].toolName, "read");
  assert.equal(typeof state.view.inFlight.tools[0].startedAt, "number");
  const partialResult = { content: [text("部分结果")] };
  receive(state, { type: "tool_execution_update", toolCallId: "t1", partialResult });
  assert.deepEqual(state.view.inFlight.tools[0].partialResult, partialResult);
  assert.equal(state.view.inFlight.tools[1].partialResult, undefined);
  receive(state, { type: "tool_execution_end", toolCallId: "t1" });
  assert.deepEqual(state.view.inFlight.tools.map(t => t.toolCallId), ["t2"]);
  receive(state, { type: "agent_settled" }); assert.deepEqual(state.view.inFlight.tools, []);
  receive(state, { type: "pane_status", status: "idle", phase: "idle", controlRevision: 10, readonly: true });
  assert.equal(state.view.readonly, true); assert.equal(state.view.inFlight.phase, "idle");
});

test("prependHistory 保留时间顺序，跨页及重复加载按条目 id 去重", () => {
  const state = fromSnapshot(snapshot());
  prependHistory(state, [entry("更早"), entry("稍早"), entry("当前")], "更早");
  assert.deepEqual(state.entries.map(e => e.id), ["更早", "稍早", "当前"]);
  prependHistory(state, [entry("最早"), entry("更早")], null);
  prependHistory(state, [entry("最早"), entry("更早")], null);
  assert.deepEqual(state.entries.map(e => e.id), ["最早", "更早", "稍早", "当前"]);
  assert.equal(state.view.historyBefore, null); assert.equal(state.version, 3);
});

test("草稿 normalize 合并文本、去空节点并保留图片，plainText 连续编号", () => {
  const nodes = [text(""), text("甲"), text("乙"), image("a"), text(""), text("丙"), image("b")];
  assert.deepEqual(normalize(nodes), [text("甲乙"), image("a"), text("丙"), image("b")]);
  assert.equal(plainText(nodes), "甲乙[Image #1]丙[Image #2]");
  assert.equal(plainText(nodes, 3), "甲乙[Image #3]丙[Image #4]");
  assert.deepEqual(imageIds(nodes), ["a", "b"]);
  assert.equal(isEmpty([text(" \n")]), true); assert.equal(isEmpty([image("a")]), false);
});

test("prependDrafts 按恢复顺序前置，以空行分隔并忽略空白草稿", () => {
  const result = prependDrafts([[text("甲")], [text(" \n")], [image("a"), text("乙")]], [text("丙")]);
  assert.deepEqual(result, [text("甲\n\n"), image("a"), text("乙\n\n丙")]);
  assert.deepEqual(prependDrafts([[], [text("甲")]], [text(" \n")]), [text("甲")]);
  assert.deepEqual(prependDrafts([], []), []);
});

test("队列图片标记与斜杠命令解析", () => {
  assert.equal(displayQueued("看 ⟦pane-img:abc123:2⟧ 与 ⟦pane-img:abcd1234:10⟧"), "看 [Image #2] 与 [Image #10]");
  assert.equal(displayQueued("⟦pane-img:abc:2⟧"), "⟦pane-img:abc:2⟧");
  assert.deepEqual(parseSlash([text("  /model  "), text("provider/model\n参数  ")]), { name: "model", args: "provider/model\n参数" });
  assert.deepEqual(parseSlash([text("/help")]), { name: "help", args: "" });
  for (const value of [[], [text("普通文本")], [text("/")], [text("//help")], [text("/help"), image("a")]]) assert.equal(parseSlash(value), null);
});

test("JCS 符合 RFC 8785 附录 B 数字、转义及 UTF-16 排序向量", () => {
  for (const [hex, expected] of NUMBER_VECTORS) {
    if (expected === null) assert.throws(() => canonicalize(hexToDouble(hex)), JcsError, hex);
    else assert.equal(canonicalize(hexToDouble(hex)), expected, hex);
  }
  assert.equal(canonicalize(JSON.parse(SAMPLE_INPUT)), SAMPLE_OUTPUT);
  assert.equal(canonicalize(JSON.parse(SORT_INPUT)), SORT_EXPECTED_OUTPUT);
  assert.equal(canonicalize(-0), "0", "RFC 8785 将负零规范化为零");
});

test("JCS 拒绝非有限数、孤立代理项及不可表示的 JSON 输入", () => {
  for (const value of [NaN, Infinity, -Infinity, "\ud800", "\udc00", { "\ud800": 1 }, { x: "\udc00" }, undefined, 1n, () => 1, { x: undefined }, new Date()]) {
    assert.throws(() => canonicalize(value), JcsError);
  }
});

test("会话树按修订号合并订阅、分页与删除，冷节点只在父节点已完整加载时显示", () => {
  const node = (id, parentId, revision, extra = {}) => ({ id, source: "x", kind: "session", parentId, title: id, status: "idle", availability: "online", hasChildren: false, sortKey: id, revision, capabilities: [], ...extra });
  const tree = new SourceTree("x");
  tree.load({ source: "x", epoch: "e1", revision: 5, nodes: [node("x:a", null, 3, { hasChildren: true, childCount: 3 }), node("x:b", "x:a", 5, { status: "running" })], foreignChildCounts: { "pane:session:1": 2 } });
  assert.deepEqual(tree.foreign, { "pane:session:1": 2 });
  const hot = (n) => isHot(n, Date.now() - 1000, new Set());
  assert.equal(tree.apply({ type: "upsert", revision: 6, node: node("x:c", "x:a", 6) }, hot), "ignored", "冷节点不显示");
  assert.equal(tree.apply({ type: "upsert", revision: 7, node: node("x:d", "x:missing", 7, { status: "running" }) }, hot), "needsAncestors");
  assert.equal(tree.apply({ type: "upsert", revision: 8, node: node("x:b", "x:a", 8, { status: "done" }) }, hot), "applied", "已显示的节点变冷后仍更新");
  assert.equal(tree.nodes.get("x:b").status, "done");
  assert.equal(tree.apply({ type: "remove", id: "x:b", revision: 9 }, hot), "applied");
  assert.equal(tree.apply({ type: "upsert", revision: 8, node: node("x:b", "x:a", 8) }, hot), "ignored", "删除之后不被旧 upsert 复活");
  // 分页：页里比本地已知旧的节点不覆盖；全部加载后新出现的冷子节点直接显示。
  tree.apply({ type: "upsert", revision: 10, node: node("x:e", "x:a", 10, { status: "running", title: "新" }) }, hot);
  tree.mergePage("x:a", [node("x:c", "x:a", 6), node("x:e", "x:a", 4, { title: "旧" })], 10);
  assert.equal(tree.nodes.get("x:e").title, "新");
  assert.deepEqual(tree.children("x:a").map((n) => n.id), ["x:c", "x:e"]);
  assert.equal(tree.listed.get("x:a").done, true);
  assert.equal(tree.apply({ type: "upsert", revision: 11, node: node("x:f", "x:a", 11) }, hot), "applied");
  assert.equal(tree.apply({ type: "reset", epoch: "e2" }, hot), "reset");
  assert.equal(tree.revision, 11);
});

test("扩展注入的 custom 消息落盘为 custom_message 后，服务端与浏览器都从进行中列表移除，只显示一份", () => {
  const server = new SessionModel(ref, { detach: value => value });
  const state = fromSnapshot(server.snapshot());
  const custom = { role: "custom", customType: "agora:notice", content: "子任务已完成", display: true, details: { task: { id: "t1" } }, timestamp: 1767225600000 };
  const end = { type: "message_end", message: custom };
  server.apply(end); receive(state, end);
  assert.equal(state.view.inFlight.completed.length, 1);
  const entry = { type: "custom_message", id: "c1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "agora:notice", content: "子任务已完成", display: true, details: { task: { id: "t1" } } };
  server.append([entry], "c1");
  receive(state, { type: "pane_entries", entries: [entry], leafId: "c1" });
  assert.deepEqual(server.snapshot().inFlight.completed ?? [], []);
  assert.deepEqual(state.view.inFlight.completed, []);
  // 内容不同的 custom 消息不被误删。
  server.apply({ type: "message_end", message: { ...custom, content: "另一条" } });
  server.append([{ ...entry, id: "c2", parentId: "c1" }], "c2");
  assert.equal(server.snapshot().inFlight.completed.length, 1);
});

test("resync 事件不按游标去重：服务端兜底的 resync 用订阅起点作游标时仍触发重取", () => {
  const state = fromSnapshot(snapshot());
  receive(state, { type: "queue_update", steering: [], followUp: [] });
  for (const cursor of [{ epoch: "epoch", seq: 10 }, { epoch: "epoch", seq: 11 }, { epoch: "epoch", seq: 3 }, { epoch: "其他", seq: 1 }]) {
    assert.equal(apply(state, { ref, cursor, event: { type: "resync" } }), "resync");
  }
  assert.equal(state.view.cursor.seq, 11);
});

const treeNode = (source, id, parentId, extra = {}) => ({ id, source, kind: "session", parentId, title: id, status: "idle", availability: "online",
  hasChildren: false, sortKey: id, revision: 1, capabilities: [], ...extra });
function forest(entries) {
  const map = new Map();
  for (const [source, snapshot] of entries) { const t = new SourceTree(source); t.load({ source, epoch: "e", revision: 5, ...snapshot }); map.set(source, t); }
  return map;
}

test("跨来源的子节点与历史数：各来源分别扣除自己的节点，未知数目只显示“历史”", () => {
  const trees = forest([
    ["pane", { nodes: [treeNode("pane", "pane:session:1", "pane:project:p"), treeNode("pane", "pane:project:p", null, { kind: "group" })] }],
    ["a", { nodes: [treeNode("a", "a:s1", "pane:session:1"), treeNode("a", "a:g", null, { kind: "group", hasChildren: true })], foreignChildCounts: { "pane:session:1": 3 } }],
    ["b", { nodes: [treeNode("b", "b:x", "a:g")], foreignChildCounts: { "pane:session:1": 2, "a:g": 4 } }],
  ]);
  const main = trees.get("pane").nodes.get("pane:session:1");
  assert.deepEqual(childrenAcross(trees, "pane:session:1").map((n) => n.id), ["a:s1"]);
  // a 报告 3、已显示 1；b 报告 2、已显示 0。b 的数目不被 a 的已加载节点抵扣。
  assert.deepEqual(hiddenChildren(trees, main), { count: 4, unknown: false, sources: ["a", "b"] });
  // 插件节点也可以有其他插件挂的子节点；自身 hasChildren 而无 childCount 时显示“历史”（数目未知）。
  const group = trees.get("a").nodes.get("a:g");
  assert.deepEqual(childrenAcross(trees, "a:g").map((n) => n.id), ["b:x"]);
  assert.deepEqual(hiddenChildren(trees, group), { count: 3, unknown: true, sources: ["a", "b"] });
  // 订阅推来的新节点不在快照数目里，不抵扣其他来源报告的数目；分页取到的节点抵扣。
  const hot = () => true;
  assert.equal(trees.get("a").apply({ type: "upsert", revision: 6, node: treeNode("a", "a:new", "pane:session:1", { revision: 6 }) }, hot), "applied");
  assert.equal(hiddenChildren(trees, main).count, 4);
  trees.get("a").mergePage("pane:session:1", [treeNode("a", "a:s2", "pane:session:1")], 6, "next");
  assert.equal(hiddenChildren(trees, main).count, 3);
  trees.get("a").mergePage("pane:session:1", [treeNode("a", "a:s3", "pane:session:1")], 6);
  assert.deepEqual(hiddenChildren(trees, main), { count: 2, unknown: false, sources: ["b"] }, "分页完毕的来源不再有历史");
  // 同一来源的父节点按 childCount（随推送更新）扣除全部已加载子节点。
  const own = forest([["x", { nodes: [treeNode("x", "x:root", null, { kind: "group", hasChildren: true, childCount: 2 }), treeNode("x", "x:c1", "x:root")] }]]);
  assert.equal(hiddenChildren(own, own.get("x").nodes.get("x:root")).count, 1);
});

test("是否还有历史以分页游标为准：已开始分页且还有下一页时差值不大于 0 也显示不带数字的“历史”，分页到底后差值大于 0 也不显示", () => {
  // 插件报告 2（有一个热节点不计入），但分页按创建顺序把它也列在第一页：第一页 2 条后差值为 0，nextCursor 仍在。
  const trees = forest([
    ["pane", { nodes: [treeNode("pane", "pane:session:1", null)] }],
    ["a", { nodes: [], foreignChildCounts: { "pane:session:1": 2 } }],
  ]);
  const main = trees.get("pane").nodes.get("pane:session:1");
  assert.deepEqual(hiddenChildren(trees, main), { count: 2, unknown: false, sources: ["a"] });
  trees.get("a").mergePage("pane:session:1", [treeNode("a", "a:hot", "pane:session:1"), treeNode("a", "a:c2", "pane:session:1")], 6, "2");
  assert.deepEqual(hiddenChildren(trees, main), { count: 0, unknown: true, sources: ["a"] }, "还有下一页，继续显示“历史”");
  trees.get("a").mergePage("pane:session:1", [treeNode("a", "a:c3", "pane:session:1")], 6);
  assert.deepEqual(hiddenChildren(trees, main), { count: 0, unknown: false, sources: [] }, "分页到底，不再有历史");
  // 同一来源的父节点同理：childCount 2 已加载 2 但还有下一页时显示“历史”；分页到底后 childCount 再大也不显示。
  const own = forest([["x", { nodes: [treeNode("x", "x:root", null, { kind: "group", hasChildren: true, childCount: 2 })] }]]);
  const root = () => own.get("x").nodes.get("x:root");
  own.get("x").mergePage("x:root", [treeNode("x", "x:c1", "x:root"), treeNode("x", "x:c2", "x:root")], 6, "2");
  assert.deepEqual(hiddenChildren(own, root()), { count: 0, unknown: true, sources: ["x"] });
  own.get("x").mergePage("x:root", [treeNode("x", "x:c3", "x:root")], 6);
  assert.equal(own.get("x").apply({ type: "upsert", revision: 7, node: { ...root(), childCount: 9, revision: 7 } }, () => true), "applied");
  assert.deepEqual(hiddenChildren(own, root()), { count: 0, unknown: false, sources: [] });
  // 没有开始分页时差值不大于 0 就没有历史。
  const fresh = forest([["y", { nodes: [treeNode("y", "y:root", null, { kind: "group", hasChildren: true, childCount: 1 }), treeNode("y", "y:c1", "y:root")] }]]);
  assert.deepEqual(hiddenChildren(fresh, fresh.get("y").nodes.get("y:root")), { count: 0, unknown: false, sources: [] });
});

test("“未归属”与普通父节点同一规则：分页还有下一页时差值不大于 0 也显示不带数字的“历史”，分页到底后不显示", () => {
  // 父节点 pane:session:gone 不在主会话树里。插件报告 2，第一页列出 2 条（含一个不计入数目的热节点）后差值为 0，nextCursor 仍在。
  const trees = forest([
    ["pane", { nodes: [] }],
    ["a", { nodes: [], foreignChildCounts: { "pane:session:gone": 2 } }],
  ]);
  const none = () => false;
  assert.deepEqual(orphanHistory(trees, none), { count: 2, unknown: false, parents: [["a", "pane:session:gone"]] });
  trees.get("a").mergePage("pane:session:gone", [treeNode("a", "a:hot", "pane:session:gone"), treeNode("a", "a:c2", "pane:session:gone")], 6, "2");
  assert.deepEqual(orphanHistory(trees, none), { count: 0, unknown: true, parents: [["a", "pane:session:gone"]] }, "还有下一页，入口不消失");
  trees.get("a").mergePage("pane:session:gone", [treeNode("a", "a:c3", "pane:session:gone")], 6);
  assert.deepEqual(orphanHistory(trees, none), { count: 0, unknown: false, parents: [] }, "分页到底");
  // 父节点在树里、被跳过（正在补取或来源还没有快照）的不计入。
  const present = forest([["pane", { nodes: [treeNode("pane", "pane:session:1", null)] }], ["a", { nodes: [], foreignChildCounts: { "pane:session:1": 3, "pane:session:x": 1 } }]]);
  assert.deepEqual(orphanHistory(present, (id) => id === "pane:session:x"), { count: 0, unknown: false, parents: [] });
});

test("重取快照保留已加载的更早历史：新快照的第一条在旧模型中时接上更早的条目，换了分支时不保留", () => {
  const view = (entries, historyBefore) => ({ ...snapshot(), entries, leafId: entries.at(-1)?.id ?? null, historyBefore });
  const prev = fromSnapshot(view([entry("c"), entry("d")], "c"));
  prependHistory(prev, [entry("a"), entry("b")], null);
  // 新快照从 c 开始：a、b 是 c 的祖先，接在前面，水位沿用旧模型的（已到开头）。
  const next = fromSnapshot(view([entry("c"), entry("d"), entry("e")], "c"));
  keepLoadedHistory(next, prev);
  assert.deepEqual(next.entries.map((e) => e.id), ["a", "b", "c", "d", "e"]); assert.equal(next.view.historyBefore, null);
  // 新快照从 d 开始（窗口后移）：a、b、c 都保留。
  const later = fromSnapshot(view([entry("d"), entry("e")], "d"));
  keepLoadedHistory(later, prev);
  assert.deepEqual(later.entries.map((e) => e.id), ["a", "b", "c", "d", "e"]);
  // 换了分支：第一条不在旧模型中，不保留，水位用新快照的。
  const other = fromSnapshot(view([entry("x")], "x"));
  keepLoadedHistory(other, prev);
  assert.deepEqual(other.entries.map((e) => e.id), ["x"]); assert.equal(other.view.historyBefore, "x");
  // 新快照已含全部条目（水位为 null）时不动。
  const full = fromSnapshot(view([entry("c"), entry("d")], null));
  keepLoadedHistory(full, prev);
  assert.deepEqual(full.entries.map((e) => e.id), ["c", "d"]);
});

test("跨来源的同级节点统一按 sortKey 排序，相同时按 id", () => {
  const trees = forest([
    ["pane", { nodes: [treeNode("pane", "pane:project:p", null, { kind: "group" }), treeNode("pane", "pane:session:1", "pane:project:p", { sortKey: "5" })] }],
    ["a", { nodes: [treeNode("a", "a:x", "pane:project:p", { sortKey: "9" }), treeNode("a", "a:y", "pane:project:p", { sortKey: "1" })] }],
    ["b", { nodes: [treeNode("b", "b:z", "pane:project:p", { sortKey: "5" })] }],
  ]);
  assert.deepEqual(childrenAcross(trees, "pane:project:p").map((n) => n.id), ["a:y", "b:z", "pane:session:1", "a:x"]);
});

test("快照的打开列表：最近打开的节点有上限；补取的父节点给不出时不再请求，不再被引用时移除，合计不超过服务端上限", () => {
  const pins = new TreePins(3, 4);
  for (const id of ["o1", "o2", "o3", "o1", "o4"]) pins.open(id);
  assert.deepEqual([...pins.opened], ["o3", "o1", "o4"], "按最近使用保留");
  assert.equal(pins.wantParent("p1"), true); assert.equal(pins.wantParent("p1"), false, "已在请求中");
  assert.equal(pins.wantParent("p2"), true);
  // 快照只给出 p1：p2 移入 notFound，不再请求。
  pins.loaded(pins.request(), (id) => id === "p1");
  assert.deepEqual([...pins.parents], ["p1"]); assert.equal(pins.wantParent("p2"), false);
  // 不再被引用的父节点（含 notFound）移除；来源 reset 后给不出的可以再请求一次。
  pins.prune(new Set(["p2"]));
  assert.deepEqual([...pins.parents], []); assert.deepEqual([...pins.notFound], ["p2"]);
  pins.retryMissing(); assert.equal(pins.wantParent("p2"), true);
  // 达到上限后不再加入。
  for (const id of ["p3", "p4", "p5"]) pins.wantParent(id);
  assert.equal(pins.wantParent("p6"), false); assert.equal(pins.parents.size, 4);
  // 默认上限下请求永远不超过服务端的 1000 个。
  const big = new TreePins();
  for (let i = 0; i < 1500; i++) { big.open("o" + i); big.wantParent("p" + i); }
  assert.ok(big.request().length <= MAX_OPEN_NODE_IDS);
});

test("补取父节点：名额已满时，删除节点腾出的名额在同一次扫描里就能用上", () => {
  const trees = forest([
    ["pane", { nodes: [] }],
    ["a", { nodes: [treeNode("a", "a:1", "pane:session:1"), treeNode("a", "a:2", "pane:session:2")] }],
  ]);
  const pinned = new Map([["pane", new TreePins(3, 2)]]);
  const pinsOf = (source) => { let p = pinned.get(source); if (!p) { p = new TreePins(3, 2); pinned.set(source, p); } return p; };
  assert.deepEqual([...missingParents(trees, pinned, pinsOf).get("pane")], ["pane:session:1", "pane:session:2"]);
  // 名额已满：删除最后一个引用 pane:session:1 的节点，同时新节点要补取 pane:session:3。
  const a = trees.get("a");
  assert.equal(a.apply({ type: "remove", id: "a:1", revision: 6 }, () => true), "applied");
  a.apply({ type: "upsert", node: treeNode("a", "a:3", "pane:session:3"), revision: 7 }, () => true);
  const wanted = missingParents(trees, pinned, pinsOf);
  assert.deepEqual([...(wanted.get("pane") ?? [])], ["pane:session:3"]);
  assert.deepEqual([...pinned.get("pane").parents].sort(), ["pane:session:2", "pane:session:3"]);
  // 已加载的父节点和还没有快照的来源不申请。
  const fresh = forest([["a", { nodes: [treeNode("a", "a:x", "b:missing")] }]]);
  fresh.set("b", new SourceTree("b"));
  assert.equal(missingParents(fresh, new Map(), pinsOf).size, 0);
});

test("“未归属”：父节点所在来源已加载却没有它、来源不存在、指向未归属分组或形成循环", () => {
  const trees = forest([
    ["pane", { nodes: [treeNode("pane", "pane:session:1", null)] }],
    ["a", { nodes: [
      treeNode("a", "a:ok", "pane:session:1"), treeNode("a", "a:lost", "pane:session:9"), treeNode("a", "a:un", "pane:group:unassigned"),
      treeNode("a", "a:other", "zz:node"), treeNode("a", "a:cross", "b:missing"), treeNode("a", "a:c1", "a:c2"), treeNode("a", "a:c2", "a:c1"),
      treeNode("a", "a:under-cycle", "a:c1"),
    ] }],
    ["b", { nodes: [] }],
  ]);
  const t = trees.get("a"); const of = (id) => unassigned(trees, t.nodes.get(id));
  assert.equal(of("a:ok"), false);
  assert.equal(of("a:lost"), true);
  assert.equal(of("a:un"), true);
  assert.equal(of("a:other"), true, "父节点的来源不存在");
  assert.equal(of("a:cross"), true, "另一个插件已加载却没有该父节点");
  assert.equal(of("a:c1"), true); assert.equal(of("a:c2"), true, "循环里的节点");
  assert.equal(of("a:under-cycle"), false, "挂在循环节点下的节点跟随父节点显示");
  assert.equal(unassigned(trees, t.nodes.get("a:lost"), (id) => id === "pane:session:9"), false, "已为父节点重取快照、结果未到时暂不归入");
  const unloaded = new SourceTree("b"); trees.set("b", unloaded);
  assert.equal(of("a:cross"), false, "父节点的来源还没有快照时等待");
});

test("树 reset 之后、新快照之前：分页作废，load 之后恢复并重建 baseline", () => {
  const tree = new SourceTree("x");
  tree.load({ source: "x", epoch: "e", revision: 5, nodes: [treeNode("x", "x:a", null)] });
  const generation = tree.generation;
  assert.equal(tree.stale, false);
  assert.equal(tree.apply({ type: "reset", epoch: "e" }, () => true), "reset");
  assert.equal(tree.stale, true);
  tree.load({ source: "x", epoch: "e", revision: 7, nodes: [] });
  assert.equal(tree.stale, false); assert.ok(tree.generation > generation, "同 epoch 的新快照也换代，旧分页据此丢弃");
  assert.equal(tree.baseline.size, 0);
});

test("通知：自动消失的最多 5 条，error 与 sticky 不被挤掉；同 id 只显示一次", () => {
  const n = (id, level = "info", sticky) => ({ id, source: "s", level, title: id, ...(sticky ? { sticky } : {}) });
  let list = [];
  list = addNotificationTo(list, n("e1", "error")); list = addNotificationTo(list, n("s1", "info", true));
  for (let i = 0; i < 7; i++) list = addNotificationTo(list, n("i" + i, i % 2 ? "warning" : "info"));
  assert.deepEqual(list.map((x) => x.id), ["e1", "s1", "i2", "i3", "i4", "i5", "i6"]);
  assert.equal(addNotificationTo(list, n("e1", "error")), list);
});

test("横幅排序与折叠、标题栏动作上限、侧栏宽度范围、文字放回", () => {
  const b = (id, level) => ({ id, source: "s", level, title: id, sourceUnavailable: false });
  const sorted = sortBanners([b("i", "info"), b("w", "warning"), b("e1", "error"), b("e2", "error")]);
  assert.deepEqual(sorted.map((x) => x.id), ["e1", "e2", "w", "i"]);
  assert.deepEqual(visibleBanners(sorted, false), { shown: sorted.slice(0, 2), folded: 2 });
  assert.deepEqual(visibleBanners(sorted, true), { shown: sorted, folded: 0 });
  assert.deepEqual(visibleBanners(sorted.slice(0, 3), false), { shown: sorted.slice(0, 3), folded: 0 }, "3 条以内全部显示");
  assert.deepEqual(splitActions([1, 2, 3, 4, 5]), { shown: [1, 2, 3], more: [4, 5] });
  assert.deepEqual([100, 240, 300, 480, 900, NaN].map(clampSidebar), [240, 240, 300, 480, 480, 280]);
  assert.equal(restoreText("提交的", ""), "提交的");
  assert.equal(restoreText("提交的", "期间新写的"), "提交的\n期间新写的");
});
