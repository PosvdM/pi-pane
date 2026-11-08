import { PaneError } from "./errors.js";

/** 同步登记异步工作；关闭门禁后只允许已登记资源完成其内部收尾。 */
export class Inflight {
  private closing = false;
  private pending = new Map<symbol, { kind: string; done: Promise<void> }>();
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
    const done = new Promise<void>(resolve => { finish = resolve; }); this.pending.set(key, { kind, done });
    return {
      run: <T>(child: string, operation: () => T | PromiseLike<T>): Promise<T> => active
        ? this.track(`${kind}.${child}`, operation) : Promise.reject(this.stopping()),
      close: () => { if (active) { active = false; this.pending.delete(key); finish(); } },
    };
  }
  /** 排空后的终止阶段只用于释放实例锁；其拒绝仍由调用方缓存为关闭失败。 */
  finalize<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T> {
    if (!this.closing || this.pending.size) return Promise.reject(new Error("关闭屏障尚未排空"));
    return this.track(kind, operation);
  }
  private track<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T> {
    const key = Symbol(kind); let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; }); this.pending.set(key, { kind, done });
    const complete = () => { this.pending.delete(key); finish(); };
    try { return Promise.resolve(operation()).then(value => { complete(); return value; }, error => { complete(); throw error; }); }
    catch (error) { complete(); return Promise.reject(error); }
  }
  async drain(): Promise<void> {
    // 已受理资源可能继续登记停止或迟到清理；反复排空直到所有生产者结束。
    while (this.pending.size) await Promise.all([...this.pending.values()].map(item => item.done));
  }
}
export interface InflightOwner {
  run<T>(kind: string, operation: () => T | PromiseLike<T>): Promise<T>;
  close(): void;
}
