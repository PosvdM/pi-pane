import { randomBytes } from "node:crypto";
import { isSameProcess, type ProcessIdentity } from "pi-hostkit";
import { assert } from "./errors.js";
export type TrustChoice = { trusted: boolean; remember: boolean };
interface BridgeRun {
  ticket: string; token?: string; expires: number; instance: number; identity?: ProcessIdentity;
  decisions: Record<string, TrustChoice>; handler: (event: any) => Promise<any>; readyPayload?: string; closed: boolean;
}
export class BridgeBroker {
  private tickets = new Map<string, BridgeRun>(); private tokens = new Map<string, BridgeRun>();
  constructor(private readonly now = Date.now) {}
  issue(decisions: Record<string, TrustChoice>, handler: (event: any) => Promise<any>): { ticket: string; attach(identity: ProcessIdentity): void; close(): void } {
    const run: BridgeRun = { ticket: randomBytes(24).toString("base64url"), expires: this.now() + 30000, instance: 0, decisions, handler, closed: false };
    this.tickets.set(run.ticket, run);
    return { ticket: run.ticket, attach: (identity) => { run.identity = identity; }, close: () => {
      run.closed = true; this.tickets.delete(run.ticket); if (run.token) this.tokens.delete(run.token);
    } };
  }
  launch(ticket: string): { token: string; decisions: Record<string, TrustChoice> } {
    const run = this.tickets.get(ticket); this.tickets.delete(ticket);
    assert(run && !run.closed && run.expires >= this.now(), "invalidBridgeTicket", "pane-bridge 启动凭证无效或已过期", 403);
    const token = randomBytes(32).toString("base64url"); run.token = token; this.tokens.set(token, run);
    return { token, decisions: run.decisions };
  }
  async event(token: string, event: any): Promise<any> {
    const run = this.tokens.get(token);
    assert(run && !run.closed, "invalidBridgeCredential", "pane-bridge 凭证已失效", 403);
    assert(Number.isSafeInteger(event.instance) && event.instance > 0, "invalidBridgeInstance", "pane-bridge 实例号无效");
    if (run.identity) assert(await isSameProcess(run.identity) === "alive", "bridgeProcessGone", "pane-bridge 所属进程已退出", 403);
    if (event.type === "bridgeReady") {
      const payload = JSON.stringify(event);
      assert(event.instance >= run.instance, "staleBridgeInstance", "pane-bridge 实例已被替换", 409);
      if (event.instance === run.instance) { assert(run.readyPayload === payload, "bridgeReadyConflict", "同一实例的就绪信息不一致", 409); return { accepted: true }; }
      run.instance = event.instance; run.readyPayload = payload;
    } else {
      // project_trust 发生于新实例 session_start 之前；它只能查询决定，不能改变会话写锁。
      assert(event.instance === run.instance || event.type === "trust" && event.instance === run.instance + 1, "staleBridgeInstance", "pane-bridge 实例已被替换", 409);
    }
    return run.handler(event);
  }
}
