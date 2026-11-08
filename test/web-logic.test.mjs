import test from "node:test";
import assert from "node:assert/strict";
import { fromSnapshot, apply, prependHistory } from "../packages/web/src/lib/session-model.ts";
import { normalize, plainText, prependDrafts, displayQueued, parseSlash, isEmpty, imageIds } from "../packages/web/src/lib/draft.ts";
import { canonicalize, JcsError } from "../packages/web/src/lib/jcs.ts";
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
