import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const log = (method: string, result: unknown) => {
    const file = process.env.PANE_UI_LOG;
    if (!file) throw new Error("必须设置 PANE_UI_LOG");
    // JSON 不表示 undefined；将此类结果记录为 null，保留 result 字段。
    appendFileSync(file, JSON.stringify({ method, result: result ?? null }) + "\n");
  };

  pi.registerCommand("pane-dialogs", { handler: async (_args, ctx) => {
    log("select", await ctx.ui.select("选择颜色", ["红", "绿", "蓝"]));
    log("confirm", await ctx.ui.confirm("确认继续", "是否继续？"));
    log("input", await ctx.ui.input("输入名称", "占位文字"));
    log("editor", await ctx.ui.editor("编辑文本", "第一行\n第二行"));
    ctx.ui.notify("对话框测试完成", "info");
  } });

  pi.registerCommand("pane-dialog-timeout", { handler: async (_args, ctx) => {
    log("select", await ctx.ui.select("会超时", ["甲", "乙"], { timeout: 1500 }));
  } });

  pi.registerCommand("pane-widgets", { handler: async (_args, ctx) => {
    ctx.ui.setStatus("t", "状态文字");
    ctx.ui.setWidget("w", ["组件第一行", "组件第二行"]);
    ctx.ui.setTitle("测试标题");
    ctx.ui.setEditorText("扩展写入的文字");
  } });
}
