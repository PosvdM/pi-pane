import { createHash } from "node:crypto";
import { assert, PaneError } from "./errors.js";
function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
export class RequestLedger {
  private records = new Map<string, { hash: string; priority: boolean; finished?: number; result?: any; error?: unknown }>();
  constructor(private readonly now = Date.now, private readonly waitMs = 30000, private readonly maxPending = 256, private readonly maxPriorityPending = 16) {}
  execute<T>(id: string, content: unknown, action: () => Promise<T>, priority = false): Promise<T | { status: "pending" }> {
    assert(typeof id === "string" && id.length >= 1 && id.length <= 256, "invalidRequestId", "requestId 必须为 1 到 256 个字符");
    this.sweep(); const hash = createHash("sha256").update(canonical(content)).digest("hex"); const previous = this.records.get(id);
    if (previous) {
      assert(previous.hash === hash, "idempotencyConflict", "同一 requestId 不能用于不同的命令内容", 409);
      if (previous.finished === undefined) return Promise.resolve({ status: "pending" });
      if (previous.error) return Promise.reject(previous.error); return Promise.resolve(structuredClone(previous.result));
    }
    const pending = [...this.records.values()].filter(record => record.finished === undefined && record.priority === priority).length;
    assert(pending < (priority ? this.maxPriorityPending : this.maxPending), "pendingLimit", "待完成请求过多，请稍后重试", 429);
    const record: { hash: string; priority: boolean; finished?: number; result?: any; error?: unknown } = { hash, priority }; this.records.set(id, record);
    const operation = Promise.resolve().then(action).then((result) => { record.finished = this.now(); record.result = structuredClone(result); return result; }, (error) => { record.finished = this.now(); record.error = error; throw error; });
    // HTTP 等待到期只返回 pending；底层操作继续写入同一条幂等记录。
    let timer: ReturnType<typeof setTimeout>;
    const waiting = new Promise<{ status: "pending" }>((resolve) => { timer = setTimeout(() => resolve({ status: "pending" }), this.waitMs); });
    return Promise.race([operation, waiting]).finally(() => clearTimeout(timer));
  }
  sweep(): void { for (const [id, record] of this.records) if (record.finished !== undefined && this.now() - record.finished > 86400000) this.records.delete(id); }
}
export class ControlQueue {
  private waiting: { action: (signal: AbortSignal) => Promise<any>; resolve: (value: any) => void; reject: (error: unknown) => void }[] = [];
  private active?: AbortController; private priorityActive = false;
  constructor(private readonly maxQueued = 64) {}
  run<T>(action: (signal: AbortSignal) => Promise<T>, priority = false): Promise<T> {
    if (priority) {
      assert(!this.priorityActive, "controlStopping", "停止操作正在执行", 409);
      this.priorityActive = true;
      return Promise.resolve().then(() => action(new AbortController().signal)).finally(() => { this.priorityActive = false; this.pump(); });
    }
    assert(!this.priorityActive, "controlStopping", "停止操作正在执行", 409);
    assert(this.waiting.length < this.maxQueued, "controlQueueLimit", "会话控制队列已满，请稍后重试", 429);
    return new Promise<T>((resolve, reject) => { this.waiting.push({ action, resolve, reject }); this.pump(); });
  }
  // 仅在停止命令通过 epoch/revision 等检查后抢占；已发出的 RPC 仍等待真实结果或传输关闭。
  preempt(): boolean {
    const error = new PaneError("controlPreempted", "控制操作被停止请求取消", 409);
    this.active?.abort(error);
    for (const job of this.waiting.splice(0)) job.reject(error);
    return this.active !== undefined;
  }
  private pump(): void {
    if (this.active || this.priorityActive) return;
    const job = this.waiting.shift(); if (!job) return;
    const controller = new AbortController(); this.active = controller;
    void Promise.resolve().then(() => job.action(controller.signal)).then(job.resolve, job.reject).finally(() => { this.active = undefined; this.pump(); });
  }
}
