import { duration, PaneError } from "./errors.js";

export const CLOSE_IO_TIMEOUT_MS = 5000;
interface Pending { kind: string; source: string; done: Promise<void> }

/** 同步登记异步工作；关闭门禁后只允许已登记资源完成其内部收尾。 */
export class Inflight {
  private closing = false;
  private pending = new Map<symbol, Pending>();
  private timeoutError?: PaneError;
  private entry(kind: string, done: Promise<void>): Pending {
    return { kind, done, source: new Error().stack?.split("\n").slice(2).join("\n") ?? "unknown" };
  }
  /** 关闭超时是终止失败；迟到成功不能继续释放锁或删除恢复现场。 */
  assertCleanupAllowed(): void { if (this.timeoutError) throw this.timeoutError; }
  async wait<T>(operation: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
    duration(timeoutMs, 25000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const pending = [...this.pending.values()].map(({ kind, source }) => ({ kind, source }));
          const error = new PaneError("shutdownTimeout", `${phase}超过 ${timeoutMs} 毫秒，清理未确认；未结束登记：${pending.map(item => `${item.kind}\n${item.source}`).join("\n") || "无"}`,
            503, { phase, timeoutMs, pending });
          this.timeoutError ??= error; reject(error);
        }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private stopping(): PaneError { return new PaneError("serverStopping", "服务端正在关闭", 503); }
  seal(): void { this.closing = true; }
  run<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.closing) return Promise.reject(this.stopping());
    return this.track(kind, operation);
  }
  runSync<T>(kind: string, operation: () => T): T {
    const owner = this.owner(kind);
    try { return operation(); } finally { owner.close(); }
  }
  /** owner 的存续期包括空闲持锁、停止及排空；它不是关闭后的新操作入口。 */
  owner(kind: string): InflightOwner {
    if (this.closing) throw this.stopping();
    const key = Symbol(kind); let finish!: () => void; let active = true;
    const done = new Promise<void>(resolve => { finish = resolve; }); this.pending.set(key, this.entry(kind, done));
    return {
      run: <T>(child: string, operation: () => T | PromiseLike<T>): Promise<T> => active
        ? this.track(`${kind}.${child}`, operation) : Promise.reject(this.stopping()),
      close: () => { if (active) { active = false; this.pending.delete(key); finish(); } },
    };
  }
  /** 排空后的终止阶段只用于释放实例锁；其拒绝仍由调用方缓存为关闭失败。 */
  finalize<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.timeoutError) return Promise.reject(this.timeoutError);
    if (!this.closing || this.pending.size) return Promise.reject(new Error("关闭屏障尚未排空"));
    return this.track(kind, operation);
  }
  private track<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T> {
    const key = Symbol(kind); let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; }); this.pending.set(key, this.entry(kind, done));
    const complete = () => { this.pending.delete(key); finish(); };
    try { return Promise.resolve(operation()).then(value => { complete(); return value; }, error => { complete(); throw error; }); }
    catch (error) { complete(); return Promise.reject(error); }
  }
  drain(timeoutMs = 25000): Promise<void> {
    return this.wait(this.performDrain(), timeoutMs, "关闭停止及排空");
  }
  private async performDrain(): Promise<void> {
    // 已受理资源可能继续登记停止或迟到清理；超时不会删除登记或伪造完成。
    while (this.pending.size) await Promise.all([...this.pending.values()].map(item => item.done));
  }
}
export interface InflightOwner {
  run<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T>;
  close(): void;
}
