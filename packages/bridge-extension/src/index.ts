import { comparisonKey, realPathOrPending } from "pi-hostkit/paths";
import { restoreImages } from "./images.js";

const key = Symbol.for("pi-pane.bridge");
interface Connection { token: string; url: string; sequence: number; decisions: Record<string, { trusted: boolean; remember: boolean }> }
type BridgeGlobal = typeof globalThis & { [key]?: Connection };
interface ExtensionApi {
  on(event: string, handler: (event: any, ctx: any) => any): void;
  events: { on(event: string, handler: (data: any) => void): () => void; emit(event: string, data: any): void };
}
function pathKey(file: string): string { return comparisonKey(realPathOrPending(file)); }
async function post(url: string, body: unknown, token?: string, timeoutMs = 10000): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`pane-bridge 回连被拒绝：${response.status}`);
  return response.json();
}
export default async function bridge(pi: ExtensionApi): Promise<void> {
  const ticket = process.env.PANE_BRIDGE_TICKET; delete process.env.PANE_BRIDGE_TICKET;
  const global = globalThis as BridgeGlobal;
  let connection = global[key];
  if (!connection) {
    if (!ticket || !process.env.PANE_BRIDGE_URL) throw new Error("pane-bridge 启动凭证缺失");
    const url = process.env.PANE_BRIDGE_URL;
    const reply = await post(url + "/bridge/launch", { ticket });
    connection = global[key] = { token: reply.token, url, sequence: 0, decisions: reply.decisions };
  }
  const conn = connection; const instance = ++conn.sequence;
  const call = (type: string, data: object = {}, timeoutMs = 10000) => post(conn.url + "/bridge/event", { ...data, type, instance }, conn.token, timeoutMs);
  let start: Promise<unknown> | undefined; const unsubscribe: (() => void)[] = [];
  pi.on("project_trust", async (event) => {
    const cwd = pathKey(event.cwd); let choice = conn.decisions[cwd];
    if (!choice) {
      try { const result = await call("trust", { cwd: event.cwd }, 59000); choice = result.decision; if (choice) conn.decisions[cwd] = choice; }
      catch { return { trusted: "undecided" }; }
    }
    return choice ? { trusted: choice.trusted ? "yes" : "no", remember: choice.remember } : { trusted: "undecided" };
  });
  pi.on("session_before_switch", async (event) => {
    if (event.reason !== "resume") return;
    try { const reply = await call("lock", { target: event.targetSessionFile, reason: "resume" }); return { cancel: !reply.acquired }; }
    catch { return { cancel: true }; }
  });
  pi.on("session_before_fork", async () => {
    try { await call("beforeFork"); } catch { return { cancel: true }; }
  });
  pi.on("session_shutdown", async (event) => {
    for (const remove of unsubscribe.splice(0)) remove();
    await call("shutdown", { reason: event.reason, target: event.targetSessionFile });
  });
  pi.on("session_start", async (event, ctx) => {
    if (!start) {
      unsubscribe.push(pi.events.on("pane:form:request", (data) => {
        // 多题表单由 M2 接入；未启用的通道以 aborted 结束，不能伪造用户取消。
        pi.events.emit("pane:form:response", { requestId: data.requestId, outcome: { status: "aborted" } });
      }));
      start = call("bridgeReady", { reason: event.reason, sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
    }
    await start;
  });
  pi.on("message_end", (event, ctx) => {
    const result = restoreImages(event.message);
    if (result.invalid) ctx.ui.notify("图片顺序未还原", "warning");
    if (result.message) return { message: result.message };
  });
}
