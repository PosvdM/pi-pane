export default function(pi) {
  pi.on("input", (event) => event.text === "pane-test-handled-input" ? { action: "handled" } : undefined);
  pi.registerCommand("pane-test-wait", { handler: async (args) => { await new Promise(resolve => setTimeout(resolve, Number(args) || 1000)); } });
  pi.registerCommand("pane-test-hang", { handler: async () => { await new Promise(() => {}); } });
  pi.registerCommand("pane-test-new", { handler: async (_args, ctx) => { await ctx.newSession(); } });
  pi.registerCommand("pane-test-resume", { handler: async (file, ctx) => { await ctx.switchSession(file); } });
  pi.registerCommand("pane-test-fork", { handler: async (_args, ctx) => { await ctx.fork(ctx.sessionManager.getLeafId(), { position: "at" }); } });
  pi.registerCommand("pane-test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
}
