import { appendFileSync } from "node:fs";
const globalKey = Symbol.for("pane-test.bridge-fault");
export default async function(pi) {
  const mode = process.env.PANE_TEST_FAULT;
  const log = value => appendFileSync(process.env.PANE_TEST_FAULT_LOG, JSON.stringify(value) + "\n");
  if (!globalThis[Symbol.for("pane-test.stdin-audit")]) {
    globalThis[Symbol.for("pane-test.stdin-audit")] = true;
    process.stdin.on("data", chunk => { for (const line of chunk.toString().split("\n")) { try { log({ rpcInput: JSON.parse(line).type, at: Date.now() }); } catch {} } });
  }
  const ticket = process.env.PANE_BRIDGE_TICKET;
  if (mode === "bad-ticket" && ticket) process.env.PANE_BRIDGE_TICKET = "invalid";
  if (mode === "stolen-ticket" && ticket) {
    const reply = await fetch(process.env.PANE_BRIDGE_URL + "/bridge/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) }); log({ stolen: reply.status });
  }
  if (!globalThis[globalKey]) {
    globalThis[globalKey] = { instances: 0, switched: new Set() };
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      let body;
      try { body = JSON.parse(options?.body); } catch {}
      if (String(url).endsWith("/bridge/event") && body?.type === "bridgeReady") {
        log({ readyAttempt: body.instance, reason: body.reason, file: body.sessionFile });
        if (mode === "no-ready" || mode === "timer-switch" || mode === "reload-no-ready" && body.instance > 1 || mode === "switch-no-ready" && body.instance > 1) return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        if (mode === "reload-disconnect" && body.instance > 1 || mode === "switch-disconnect" && body.instance > 1) throw new Error("测试注入回连中断");
      }
      return original(url, options);
    };
  }
  pi.registerCommand("pane-test-new", { handler: async (_args, ctx) => { const result = await ctx.newSession(); log({ command: "new", result }); } });
  pi.registerCommand("pane-test-resume", { handler: async (_args, ctx) => { const result = await ctx.switchSession(process.env.PANE_TEST_TARGET); log({ command: "resume", result }); } });
  pi.registerCommand("pane-test-fork", { handler: async (_args, ctx) => { const result = await ctx.fork(ctx.sessionManager.getLeafId(), { position: "at" }); log({ command: "fork", result }); } });
  pi.registerCommand("pane-test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.on("session_start", (_event, ctx) => {
    const memory = globalThis[globalKey]; const instance = ++memory.instances;
    if (mode !== "timer-switch") return;
    const actions = ["new", "resume", "fork"];
    const action = actions[instance - 1]; if (!action || memory.switched.has(action)) return;
    memory.switched.add(action);
    setTimeout(() => { log({ timer: action, file: ctx.sessionManager.getSessionFile() }); pi.sendUserMessage("/pane-test-" + action, { expandPromptTemplates: true }); }, 100);
  });
}
