export default function(pi) {
  let cancelTransitions = false;
  pi.on("session_before_switch", () => cancelTransitions ? { cancel: true } : undefined);
  pi.on("session_before_fork", () => cancelTransitions ? { cancel: true } : undefined);
  pi.registerCommand("pane-web-ready", { handler: async () => {} });
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
