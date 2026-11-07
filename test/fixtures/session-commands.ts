export default function(pi) {
  pi.registerCommand("pane-test-wait", { handler: async (args) => { await new Promise(resolve => setTimeout(resolve, Number(args) || 1000)); } });
  pi.registerCommand("pane-test-new", { handler: async (_args, ctx) => { await ctx.newSession(); } });
  pi.registerCommand("pane-test-resume", { handler: async (file, ctx) => { await ctx.switchSession(file); } });
  pi.registerCommand("pane-test-fork", { handler: async (_args, ctx) => { await ctx.fork(ctx.sessionManager.getLeafId(), { position: "at" }); } });
  pi.registerCommand("pane-test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
}
