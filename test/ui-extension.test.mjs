import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import register from "./fixtures/ui-extension.ts";

test("扩展 fixture 按顺序记录对话框结果，传递 timeout 并发送组件请求", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pane-ui-fixture-"));
  const previous = process.env.PANE_UI_LOG;
  process.env.PANE_UI_LOG = path.join(root, "ui.jsonl");
  try {
    const commands = new Map();
    register({ registerCommand: (name, command) => commands.set(name, command.handler) });
    assert.deepEqual([...commands.keys()], ["pane-dialogs", "pane-dialog-timeout", "pane-widgets"]);
    const calls = [];
    const ui = Object.fromEntries([
      ["select", "绿"], ["confirm", false], ["input", ""], ["editor", "多行\n结果"],
      ["notify"], ["setStatus"], ["setWidget"], ["setTitle"], ["setEditorText"],
    ].map(([method, result]) => [method, (...args) => { calls.push([method, ...args]); return result; }]));
    await commands.get("pane-dialogs")("", { ui });
    assert.deepEqual(calls, [
      ["select", "选择颜色", ["红", "绿", "蓝"]],
      ["confirm", "确认继续", "是否继续？"],
      ["input", "输入名称", "占位文字"],
      ["editor", "编辑文本", "第一行\n第二行"],
      ["notify", "对话框测试完成", "info"],
    ]);
    ui.select = (...args) => { calls.push(["select", ...args]); return undefined; };
    await commands.get("pane-dialog-timeout")("", { ui });
    assert.deepEqual(calls.at(-1), ["select", "会超时", ["甲", "乙"], { timeout: 1500 }]);
    const records = (await readFile(process.env.PANE_UI_LOG, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records, [
      { method: "select", result: "绿" }, { method: "confirm", result: false },
      { method: "input", result: "" }, { method: "editor", result: "多行\n结果" },
      { method: "select", result: null },
    ]);
    calls.length = 0;
    await commands.get("pane-widgets")("", { ui });
    assert.deepEqual(calls, [
      ["setStatus", "t", "状态文字"], ["setWidget", "w", ["组件第一行", "组件第二行"]],
      ["setTitle", "测试标题"], ["setEditorText", "扩展写入的文字"],
    ]);
  } finally {
    if (previous === undefined) delete process.env.PANE_UI_LOG; else process.env.PANE_UI_LOG = previous;
    await rm(root, { recursive: true, force: true });
  }
});
