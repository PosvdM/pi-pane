export default function(pi) {
  let cancelTransitions = false;
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    const transform = event.text.startsWith("pane-queue-transform ");
    const handled = event.text.startsWith("pane-queue-handled ");
    if (!transform && !handled) return;
    // 扩展消息先入队；原输入保留图片，正文不保留 pane 图片标记。
    const auxiliary = event.text.includes("同文辅助") ? "扩展固定正文" : "扩展辅助消息";
    pi.sendUserMessage(auxiliary, { deliverAs: "followUp" });
    return handled ? { action: "handled" } : { action: "transform", text: "扩展固定正文", images: event.images };
  });
  pi.on("session_before_switch", () => cancelTransitions ? { cancel: true } : undefined);
  pi.on("session_before_fork", () => cancelTransitions ? { cancel: true } : undefined);
  pi.registerCommand("pane-web-ready", { handler: async () => {} });
  pi.registerCommand("debug", { handler: async (args) => { pi.setSessionName(args); } });
  pi.registerCommand("pane-web-state", { handler: async (args) => {
    const [kind, value] = args.split(" ");
    if (kind === "thinking") pi.setThinkingLevel(value);
    else if (kind === "name") pi.setSessionName(value);
  } });
  pi.registerCommand("pane-web-cancel-transitions", { handler: async () => { cancelTransitions = true; } });
  pi.registerCommand("pane-web-dialog", { handler: async (args, ctx) => {
    const [kind, timeout] = args.split(" ");
    const options = timeout ? { timeout: Number(timeout) } : undefined;
    if (kind === "select") await ctx.ui.select("选择项目", ["甲", "乙"], options);
    else if (kind === "confirm") await ctx.ui.confirm("确认操作", "是否继续？", options);
    else if (kind === "input") await ctx.ui.input("输入内容", "请输入", options);
    else if (kind === "editor") await ctx.ui.editor("编辑内容", "初始内容");
  } });
}
