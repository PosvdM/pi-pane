import { createHash } from "node:crypto";
import { assert } from "./errors.js";
function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
export class RequestLedger {
  private records = new Map<string, { hash: string; finished?: number; result?: any; error?: unknown }>();
  constructor(private readonly now = Date.now, private readonly waitMs = 30000) {}
  execute<T>(id: string, content: unknown, action: () => Promise<T>): Promise<T | { status: "pending" }> {
    assert(typeof id === "string" && id.length >= 1 && id.length <= 256, "invalidRequestId", "requestId 必须为 1 到 256 个字符");
    this.sweep(); const hash = createHash("sha256").update(canonical(content)).digest("hex"); const previous = this.records.get(id);
    if (previous) {
      assert(previous.hash === hash, "idempotencyConflict", "同一 requestId 不能用于不同的命令内容", 409);
      if (previous.finished === undefined) return Promise.resolve({ status: "pending" });
      if (previous.error) return Promise.reject(previous.error); return Promise.resolve(structuredClone(previous.result));
    }
    const record: { hash: string; finished?: number; result?: any; error?: unknown } = { hash }; this.records.set(id, record);
    const operation = Promise.resolve().then(action).then((result) => { record.finished = this.now(); record.result = structuredClone(result); return result; }, (error) => { record.finished = this.now(); record.error = error; throw error; });
    // HTTP 等待到期只返回 pending；底层操作继续写入同一条幂等记录。
    let timer: ReturnType<typeof setTimeout>;
    const waiting = new Promise<{ status: "pending" }>((resolve) => { timer = setTimeout(() => resolve({ status: "pending" }), this.waitMs); });
    return Promise.race([operation, waiting]).finally(() => clearTimeout(timer));
  }
  sweep(): void { for (const [id, record] of this.records) if (record.finished !== undefined && this.now() - record.finished > 86400000) this.records.delete(id); }
}
export class ControlQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action); this.tail = result.catch(() => {}); return result;
  }
}
