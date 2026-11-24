import test from "node:test";
import assert from "node:assert/strict";
import { toPaneSessionListItem, toPaneModel, toPaneState, toPaneQuery, toPaneOutcome, toPaneUiRequest, toPiUiAnswer, isPaneQueryType } from "../packages/server/dist/web-adapter.js";

const model = { provider: "fake", id: "test", name: "测试模型", reasoning: true, input: ["text", "image"], contextWindow: 1000, api: "secret", baseUrl: "private", headers: { Authorization: "secret" } };
test("会话列表只提取 pane 字段，标题限长、日期转 ISO", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const row = toPaneSessionListItem({ path: "会话", id: "id", cwd: "目录", name: "名称", firstMessage: "字".repeat(300), created: date, modified: date, messageCount: 3, parentSessionPath: "父会话", allMessagesText: "禁止下发" }, true, "idle");
  assert.equal(toPaneSessionListItem({ path: "空会话", id: "empty", cwd: "目录", firstMessage: "(no messages)", created: date, modified: date, messageCount: 0 }, false).title, "");
  assert.deepEqual(row, { sessionFile: "会话", id: "id", cwd: "目录", name: "名称", title: "字".repeat(200), createdAt: date.toISOString(), modifiedAt: date.toISOString(), messageCount: 3, parentSessionFile: "父会话", hosted: true, status: "idle" });
});
test("模型和状态不暴露原始配置", () => {
  const expected = { provider: "fake", id: "test", name: "测试模型", reasoning: true, images: true, contextWindow: 1000 };
  assert.deepEqual(toPaneModel(model), expected);
  assert.deepEqual(toPaneState({ sessionId: "id", sessionFile: "file", sessionName: "名称", model, thinkingLevel: "high", isStreaming: true, isCompacting: false, pendingMessageCount: 2, private: true }), {
    sessionId: "id", sessionFile: "file", sessionName: "名称", model: expected, thinkingLevel: "high", running: true, compacting: false, pendingMessages: 2,
  });
  assert.deepEqual(toPaneState({ sessionId: "id", sessionFile: "file" }), { sessionId: "id", sessionFile: "file", running: false, compacting: false, pendingMessages: 0 });
  assert.equal(toPaneModel({ provider: "fake", id: "text", name: "文字" }).images, false);
});
test("查询映射提取命令、统计和分叉点字段", () => {
  assert.deepEqual(toPaneQuery("models", { models: [model] }), { models: [toPaneModel(model)] });
  assert.deepEqual(toPaneQuery("state", { sessionId: "id", sessionFile: "file" }), toPaneState({ sessionId: "id", sessionFile: "file" }));
  assert.deepEqual(toPaneQuery("commands", { commands: [{ name: "test", source: "extension", description: "测试", sourceInfo: { scope: "project", path: "private" } }, { name: "other", source: "skill" }] }), { commands: [{ name: "test", source: "extension", description: "测试", scope: "project" }, { name: "other", source: "skill" }] });
  const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
  const raw = { userMessages: 1, assistantMessages: 2, toolCalls: 3, totalMessages: 8, tokens, cost: 0.1 };
  assert.deepEqual(toPaneQuery("stats", raw), { messages: { user: 1, assistant: 2, toolCalls: 3, total: 8 }, tokens, cost: 0.1 });
  assert.deepEqual(toPaneQuery("stats", { ...raw, contextUsage: { tokens: null, percent: null, contextWindow: 1000 } }).context, { tokens: null, percent: null, window: 1000 });
  assert.deepEqual(toPaneQuery("forkPoints", { messages: [{ entryId: "id", text: "消息", private: true }] }), { points: [{ entryId: "id", text: "消息" }] });
  for (const name of ["get_state", "get_entries", "get_last_assistant_text", "__proto__", "toString", null]) assert.equal(isPaneQueryType(name), false);
});
test("命令结果仅暴露 handled 和 cancelled", () => {
  for (const type of ["prompt", "steer", "follow_up"]) {
    assert.deepEqual(toPaneOutcome(type, { disposition: "handled" }), { handled: true });
    for (const disposition of ["queued", "started"]) assert.equal(toPaneOutcome(type, { disposition }), undefined);
  }
  for (const type of ["new_session", "fork", "clone"]) {
    assert.deepEqual(toPaneOutcome(type, { cancelled: true }), { cancelled: true });
    assert.equal(toPaneOutcome(type, { cancelled: false }), undefined);
  }
});
test("扩展 UI 转换全部方法并固定收到时的期限", () => {
  const convert = (method, fields = {}) => toPaneUiRequest({ type: "extension_ui_request", id: "id", method, ...fields }, 0);
  assert.deepEqual(convert("select", { title: "选择", options: ["甲", "乙"], timeout: 1234 }), { id: "id", kind: "select", title: "选择", options: ["甲", "乙"], expiresAt: "1970-01-01T00:00:01.234Z" });
  for (const kind of ["confirm", "input", "editor"]) assert.deepEqual(convert(kind, { title: "标题" }), { id: "id", kind, title: "标题" });
  assert.deepEqual(convert("notify", { message: "消息" }), { id: "id", kind: "notify", message: "消息", level: "info" });
  assert.equal(convert("notify", { notifyType: "error" }).level, "error");
  assert.deepEqual(convert("setStatus", { statusKey: "key", statusText: "内容" }), { id: "id", kind: "status", key: "key", text: "内容" });
  assert.deepEqual(convert("setStatus", { statusKey: "key" }), { id: "id", kind: "status", key: "key" });
  assert.deepEqual(convert("setWidget", { widgetKey: "key" }), { id: "id", kind: "widget", key: "key", placement: "aboveEditor" });
  assert.deepEqual(convert("setWidget", { widgetKey: "key", widgetLines: ["行"], widgetPlacement: "belowEditor" }), { id: "id", kind: "widget", key: "key", placement: "belowEditor", lines: ["行"] });
  assert.deepEqual(convert("setTitle", { title: "标题" }), { id: "id", kind: "title", title: "标题" });
  assert.deepEqual(convert("set_editor_text", { text: "内容" }), { id: "id", kind: "editorText", text: "内容" });
  assert.equal(convert("unknown"), undefined);
});
test("UI 回答严格匹配种类、值类型与选项", () => {
  for (const kind of ["select", "input", "editor", "confirm"]) {
    const request = { id: "id", kind, title: "标题", options: ["甲"] };
    assert.deepEqual(toPiUiAnswer(request), { id: "id", cancelled: true });
    const answer = kind === "confirm" ? { confirmed: false } : { value: "甲" };
    assert.deepEqual(toPiUiAnswer(request, answer), { id: "id", ...answer });
    for (const invalid of [null, [], {}, { value: 1 }, { confirmed: "yes" }, { ...answer, extra: true }, kind === "confirm" ? { value: "甲" } : { confirmed: true }]) {
      assert.throws(() => toPiUiAnswer(request, invalid), { code: "invalidUiAnswer", status: 400 });
    }
  }
  assert.throws(() => toPiUiAnswer({ id: "id", kind: "select", options: ["甲"] }, { value: "乙" }), { code: "invalidUiAnswer" });
});
