import { appendFileSync, existsSync } from "node:fs";
import { probeSessionWriterLock, isSameProcess } from "pi-hostkit";
import { auditStdin } from "./stdin-audit.mjs";
const globalKey = Symbol.for("pane-test.bridge-fault");
export default async function(pi) {
  const mode = process.env.PANE_TEST_FAULT;
  const log = value => appendFileSync(process.env.PANE_TEST_FAULT_LOG, JSON.stringify(value) + "\n");
  if (!globalThis[Symbol.for("pane-test.stdin-audit")]) {
    globalThis[Symbol.for("pane-test.stdin-audit")] = true;
    auditStdin(process.stdin, command => log({ rpcInput: command.type, at: Date.now() }));
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
      if (String(url).endsWith("/bridge/event")) log({ bridgeEvent: body?.type, instance: body?.instance, at: Date.now() });
      if (String(url).endsWith("/bridge/event") && body?.type === "bridgeReady") {
        const lock = await probeSessionWriterLock(body.sessionFile);
        log({ readyAttempt: body.instance, reason: body.reason, file: body.sessionFile, held: lock.held, state: lock.record?.state,
          writerAlive: lock.record?.writer ? await isSameProcess(lock.record.writer) : "missing" });
        const armed = existsSync(process.env.PANE_TEST_FAULT_ARMED);
        if (mode === "no-ready" || mode === "timer-switch" || mode === "timer-offline" || ["reload-no-ready", "switch-no-ready"].includes(mode) && armed) return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        if (["reload-disconnect", "switch-disconnect"].includes(mode) && armed) throw new Error("测试注入回连中断");
      }
      if (mode === "timer-offline" && ["beforeSwitch", "lock", "beforeFork"].includes(body?.type)) {
        const file = globalThis[globalKey].file; const lock = await probeSessionWriterLock(file);
        log({ deniedWindow: body.type, file, held: lock.held, writerAlive: lock.record?.writer ? await isSameProcess(lock.record.writer) : "missing" });
        throw new Error("测试注入切换协调离线");
      }
      const response = await original(url, options);
      if (String(url).endsWith("/bridge/event") && body?.type === "shutdown" && body.target) {
        const lock = await probeSessionWriterLock(body.target);
        log({ switchWindow: body.reason, file: body.target, held: lock.held, state: lock.record?.state,
          writerAlive: lock.record?.writer ? await isSameProcess(lock.record.writer) : "missing" });
      }
      return response;
    };
  }
  globalThis[globalKey].currentApi = pi;
  pi.registerCommand("pane-test-new", { handler: async (_args, ctx) => {
    const result = await ctx.newSession(); log({ command: "new", result });
    if (mode === "timer-offline" && result.cancelled) setTimeout(() => { log({ timer: "resume", file: ctx.sessionManager.getSessionFile() }); globalThis[globalKey].currentApi.sendUserMessage("/pane-test-resume", { expandPromptTemplates: true }); }, 100);
  } });
  pi.registerCommand("pane-test-resume", { handler: async (_args, ctx) => {
    const result = await ctx.switchSession(process.env.PANE_TEST_TARGET); log({ command: "resume", result });
    if (["timer-switch", "timer-offline"].includes(mode) && result.cancelled) setTimeout(() => {
      globalThis[globalKey].switched.add("fork"); log({ timer: "fork", file: ctx.sessionManager.getSessionFile() });
      globalThis[globalKey].currentApi.sendUserMessage("/pane-test-fork", { expandPromptTemplates: true });
    }, 100);
  } });
  pi.registerCommand("pane-test-fork", { handler: async (_args, ctx) => { const result = await ctx.fork(ctx.sessionManager.getLeafId(), { position: "at" }); log({ command: "fork", result }); } });
  pi.registerCommand("pane-test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.on("session_start", (_event, ctx) => {
    const memory = globalThis[globalKey]; const instance = ++memory.instances; memory.file = ctx.sessionManager.getSessionFile();
    if (!["timer-switch", "timer-offline"].includes(mode)) return;
    const action = ["new", "resume", "fork"].find(action => !memory.switched.has(action));
    if (!action) return;
    setTimeout(() => { memory.switched.add(action); log({ timer: action, file: ctx.sessionManager.getSessionFile() }); memory.currentApi.sendUserMessage("/pane-test-" + action, { expandPromptTemplates: true }); }, 100);
  });
}
