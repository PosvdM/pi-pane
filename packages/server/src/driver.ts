import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock,
  type Containment, type ExtensionUiResponse, type ManagedProcess, type PiInstall, type ProcessIdentity,
  type RpcCommand, type RpcResponse, type SessionWriterLock, type StopOptions, type StopReport } from "pi-hostkit";
import { BridgeBroker, type TrustChoice } from "./bridge.js";
import { assert, duration, PaneError } from "./errors.js";
import { fileKey } from "./store.js";
import { acquireRecoveredWriter } from "./writer-recovery.js";
import { verifyStopped } from "./stop-report.js";
export { checkStopReport, verifyStopped } from "./stop-report.js";

export interface DriverSpec { cwd: string; sessionFile: string; sessionDir: string; decisions: Record<string, TrustChoice>; assumeNoWriter?: boolean }
export interface DriverOptions {
  home: string; instanceId: string; pi: PiInstall; bridgeUrl: string; extensionPath: string;
  env?: Record<string, string>; extraExtensions?: string[]; containment?: Containment;
  readyTimeoutMs?: number; rpcTimeoutMs?: number; stopOptions?: StopOptions; snapshotIntervalMs?: number;
  onTrust?: (cwd: string) => Promise<TrustChoice | undefined>;
}
export interface DriverCallbacks {
  onHandle?(handle: DriverHandle): void;
  onRecord(event: any): void;
  onReady(state: any, entries: any, reason: string, handle: DriverHandle): void;
  onExit(reason: string, report?: StopReport, error?: unknown): void;
}
export interface SessionDriver { start(spec: DriverSpec, callbacks: DriverCallbacks, signal?: AbortSignal): Promise<DriverHandle> }
export interface DriverHandle {
  readonly identity: ProcessIdentity; readonly ready: Promise<void>; readonly exited: Promise<void>; readonly sessionFile: string;
  readonly acceptingInput: boolean;
  send(command: RpcCommand, opts?: { timeoutMs?: number; trackResult?: boolean }): Promise<RpcResponse>;
  respondUi(response: ExtensionUiResponse): void;
  stop(): Promise<StopReport>;
  drain(): Promise<void>;
}
export class RpcSubprocessDriver implements SessionDriver {
  constructor(private readonly broker: BridgeBroker, private readonly options: DriverOptions,
    private readonly acquireWriter = acquireSessionWriterLock) { duration(options.readyTimeoutMs, 10000); }
  async start(spec: DriverSpec, callbacks: DriverCallbacks, signal?: AbortSignal): Promise<DriverHandle> {
    signal?.throwIfAborted();
    const lock = await acquireRecoveredWriter(spec.sessionFile, this.options.home, this.options.instanceId,
      { ...this.options.stopOptions, assumeNoWriter: spec.assumeNoWriter }, this.acquireWriter);
    if (signal?.aborted) { await lock.release(); signal.throwIfAborted(); }
    let handle!: RpcHandle; let attachHandle!: () => void; const available = new Promise<void>((resolve) => { attachHandle = resolve; });
    const launch = this.broker.issue(spec.decisions, async (event) => { await available; return handle.bridgeEvent(event); });
    const env = { ...process.env, ...this.options.env, PANE_BRIDGE_URL: this.options.bridgeUrl, PANE_BRIDGE_TICKET: launch.ticket } as Record<string, string>;
    // 调用方传入完整隔离环境时不能从宿主补入模型凭证或用户配置。
    if (this.options.env) for (const name of Object.keys(env)) if (!(name in this.options.env) && !["PANE_BRIDGE_URL", "PANE_BRIDGE_TICKET"].includes(name)) delete env[name];
    const argv = [this.options.pi.cliEntry, "--mode", "rpc", "--session", spec.sessionFile, "--session-dir", spec.sessionDir,
      "-e", this.options.extensionPath];
    for (const extension of this.options.extraExtensions ?? []) argv.push("-e", extension);
    let proc: ManagedProcess;
    try {
      proc = await lock.spawnWriter({ argv, cwd: spec.cwd, env, runId: randomUUID(), instanceId: this.options.instanceId, containment: this.options.containment, snapshotIntervalMs: this.options.snapshotIntervalMs });
      launch.attach(proc.identity);
    } catch (error) {
      launch.close(); await lock.release(); throw error;
    }
    handle = new RpcHandle(proc, lock, launch.close, spec, callbacks, this.options, this.acquireWriter); attachHandle();
    try {
      // spawn 可能晚于取消返回；先交付 handle，再检查取消，停止无需等待首次持久化或 ready。
      callbacks.onHandle?.(handle);
      if (signal?.aborted) { await handle.stop(); signal.throwIfAborted(); }
      await handle.persist(); return handle;
    }
    catch (error) { await handle.stop(); throw error; }
  }
}
class RpcHandle implements DriverHandle {
  readonly identity: ProcessIdentity; readonly ready: Promise<void>; readonly exited: Promise<void>;
  private resolveReady!: () => void; private rejectReady!: (error: unknown) => void; private resolveExit!: () => void;
  private locks = new Map<string, SessionWriterLock>(); private current: SessionWriterLock;
  private enabled = false; private stopping = false; private stopPromise?: Promise<StopReport>; private fatalReason?: string;
  private timer?: ReturnType<typeof setTimeout>; private pendingTarget?: string; private switchFailure?: unknown;
  private generation = 0; private initialization = Promise.resolve(); private started = false; private listeners: (() => void)[] = [];
  private readonly recordFile: string; private persistence = Promise.resolve();
  private targets = new Set<Promise<boolean>>(); private cleanupErrors: unknown[] = [];
  constructor(private readonly proc: ManagedProcess, lock: SessionWriterLock, private readonly revoke: () => void,
    private readonly spec: DriverSpec, private readonly callbacks: DriverCallbacks, private readonly options: DriverOptions,
    private readonly acquireWriter: typeof acquireSessionWriterLock) {
    this.identity = proc.identity; this.current = lock; this.locks.set(fileKey(lock.sessionFile), lock);
    this.recordFile = path.join(options.home, "run", `${proc.identity.runId}.json`);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; }); this.ready.catch(() => {});
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.listeners.push(proc.rpc.onEvent((event) => callbacks.onRecord(event)), proc.rpc.onUiRequest((event) => callbacks.onRecord(event)), proc.rpc.onError((error) => this.fail("RPC 传输故障", error)));
    this.armTimeout();
    void proc.rpc.closed.then(() => { if (!this.stopping) this.fail("RPC 输出管道关闭"); });
    void proc.exited.then((info) => { if (!this.stopping) this.fail(this.started ? "pi 进程意外退出" : `pane-bridge 就绪前退出（${info.code}）：${proc.stderrTail()}`); });
  }
  get sessionFile(): string { return this.current.sessionFile; }
  get acceptingInput(): boolean { return this.enabled && !this.stopping; }
  persist(): Promise<void> {
    const write = this.persistence.then(async () => {
      if (this.stopping) return;
      await this.writeRecord();
    });
    // 停止等待已进入的写入（含 rename）结束；停止后才进入的持久化不创建文件。
    this.persistence = write.catch(() => {}); return write;
  }
  private async writeRecord(): Promise<void> {
    const data = JSON.stringify({ identity: this.identity, sessionFile: this.sessionFile, cwd: this.spec.cwd });
    await mkdir(path.dirname(this.recordFile), { recursive: true });
    const temp = this.recordFile + ".tmp"; await writeFile(temp, data, { mode: 0o600 }); await rename(temp, this.recordFile);
  }
  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("pane-bridge 就绪超时，请重启会话"), duration(this.options.readyTimeoutMs, 10000)); this.timer.unref();
  }
  private target(file: string): Promise<boolean> {
    const operation = this.acquireTarget(file); this.targets.add(operation);
    void operation.then(() => this.targets.delete(operation), () => this.targets.delete(operation));
    return operation;
  }
  private async acquireTarget(file: string): Promise<boolean> {
    const key = fileKey(file); if (this.locks.has(key)) return true;
    const lock = await acquireRecoveredWriter(file, this.options.home, this.options.instanceId, this.options.stopOptions, this.acquireWriter);
    // 取锁可能晚于停止返回；迟到锁不登记 writer，仍须在停止确认后清理。
    this.locks.set(key, lock);
    if (this.stopping) {
      try { await this.stop(); await lock.release(); this.locks.delete(key); }
      catch (error) { this.cleanupErrors.push(error); this.callbacks.onRecord({ type: "pane_diagnostic", message: `迟到目标锁清理未确认：${String(error)}` }); throw error; }
      throw new PaneError("bridgeStopping", "会话正在停止，目标写锁已释放", 409);
    }
    // 保留每个已取得的目标锁，直到 session_start 确认切走或写者停止。
    await lock.update({ writer: this.identity, state: "running" });
    assert(!this.stopping, "bridgeStopping", "会话正在停止", 409); return true;
  }
  async bridgeEvent(event: any): Promise<any> {
    assert(!this.stopping, "bridgeStopping", "会话正在停止", 409);
    switch (event.type) {
      case "trust": {
        // 新目录的信任决定可以等待用户；就绪截止时间从决定返回后计算，不能在弹窗期间杀掉写者。
        clearTimeout(this.timer);
        try { return { decision: await this.options.onTrust?.(event.cwd) }; }
        finally { if (!this.stopping && !this.enabled) this.armTimeout(); }
      }
      case "instance":
      case "beforeSwitch":
      case "beforeFork": return { accepted: true };
      case "lock": {
        assert(typeof event.target === "string" && path.isAbsolute(event.target), "invalidTarget", "会话目标必须是绝对路径");
        return { acquired: await this.target(event.target) };
      }
      case "shutdown": {
        if (event.reason === "quit") { this.enabled = false; return { accepted: true }; }
        this.enabled = false; const generation = ++this.generation; this.armTimeout();
        if (typeof event.target === "string") {
          this.pendingTarget = event.target;
          try { if (!await this.target(event.target)) throw new Error("目标会话正被别处托管"); }
          catch (error) { if (!this.stopping && generation === this.generation) this.switchFailure = error; }
        }
        return { accepted: true };
      }
      case "bridgeReady": {
        assert(typeof event.sessionFile === "string" && typeof event.sessionId === "string", "invalidReady", "pane-bridge 缺少会话身份");
        const generation = this.generation;
        // session_start 处理器等待此 HTTP 回应；RPC 在回应之后才会处理初始化命令。
        setImmediate(() => {
          this.initialization = this.initialization.then(async () => {
            if (this.stopping || generation !== this.generation) return;
            if (this.switchFailure) throw this.switchFailure;
            const destination = this.locks.get(fileKey(event.sessionFile));
            assert(destination, "unlockedWriter", "pi 切换到未取得写锁的会话");
            const state = await this.raw({ type: "get_state" });
            if (this.stopping || generation !== this.generation) return;
            assert(fileKey(state.data.sessionFile) === fileKey(event.sessionFile) && state.data.sessionId === event.sessionId, "readyMismatch", "pane-bridge 与 RPC 的会话身份不符");
            const entries = await this.raw({ type: "get_entries" });
            if (this.stopping || generation !== this.generation) return;
            for (const [key, lock] of this.locks) if (lock !== destination) {
              await lock.release({ writerSwitchedAway: true }); this.locks.delete(key);
              if (this.stopping || generation !== this.generation) return;
            }
            this.current = destination; this.pendingTarget = undefined;
            await this.persist();
            if (this.stopping || generation !== this.generation) return;
            this.callbacks.onReady({ ...state.data, projectTrusted: event.trusted, cwd: event.cwd }, entries.data, event.reason, this);
            if (this.stopping || generation !== this.generation) return;
            this.enabled = true; this.started = true; clearTimeout(this.timer); this.resolveReady();
          }).catch((error) => this.fail("pane-bridge 重绑定失败", error));
        });
        return { accepted: true };
      }
      default: throw new PaneError("unknownBridgeEvent", "不支持此 pane-bridge 请求");
    }
  }
  private raw(command: RpcCommand, timeoutMs = this.options.rpcTimeoutMs ?? 30000, trackResult = false): Promise<any> {
    return this.proc.rpc.send(command, trackResult ? {} : { timeoutMs }).then((response) => { assert(response.success, "rpcRejected", response.error ?? "pi 拒绝命令", 409); return response; });
  }
  async send(command: RpcCommand, opts?: { timeoutMs?: number; trackResult?: boolean }): Promise<RpcResponse> {
    assert(this.acceptingInput, "bridgeNotReady", "pane-bridge 尚未就绪或会话正在停止", 409);
    let response: RpcResponse;
    try { response = await this.raw(command, opts?.timeoutMs, opts?.trackResult); }
    catch (error) {
      if (opts?.trackResult && !(error instanceof PaneError && error.code === "rpcRejected"))
        throw new PaneError("rpcResultUnknown", "RPC 连接中断，无法确认操作结果；请读取会话状态核对", 503);
      throw error;
    }
    if (["prompt", "new_session", "fork", "clone"].includes(command.type) && this.enabled && !this.pendingTarget && this.locks.size > 1) {
      const generation = this.generation;
      try {
        const state = await this.raw({ type: "get_state" });
        if (!this.stopping && generation === this.generation && this.enabled && !this.pendingTarget && fileKey(state.data.sessionFile) === fileKey(this.current.sessionFile)) {
          for (const [key, lock] of this.locks) if (lock !== this.current) {
            await lock.release({ writerSwitchedAway: true }); this.locks.delete(key);
            if (this.stopping || generation !== this.generation) break;
          }
        }
      } catch (error) {
        // 控制响应已经确认；清理故障只记录诊断并停止写者，锁在确认进程退出前继续保留。
        this.callbacks.onRecord({ type: "pane_diagnostic", message: `切换后写锁清理未确认：${String(error)}` });
        this.fail("切换后写锁清理未确认", error);
      }
    }
    return response;
  }
  respondUi(response: ExtensionUiResponse): void { assert(this.acceptingInput, "bridgeNotReady", "pane-bridge 尚未就绪", 409); this.proc.rpc.respondUi(response); }
  private fail(reason: string, error?: unknown): void {
    if (this.stopping) return;
    this.fatalReason = `${reason}${error ? `：${String(error)}` : ""}`;
    this.rejectReady(new PaneError("bridgeFailed", this.fatalReason, 503));
    void this.stop().catch(() => {});
  }
  stop(): Promise<StopReport> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; this.enabled = false; clearTimeout(this.timer); this.revoke();
    this.stopPromise = this.performStop(); return this.stopPromise;
  }
  async drain(): Promise<void> {
    // target 的迟到锁清理需要先等 stop；关闭在 stop 完成后排空，避免循环等待。
    await Promise.allSettled([this.initialization, ...this.targets]);
    if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, "迟到目标锁清理未确认");
  }
  private async performStop(): Promise<StopReport> {
    let report: StopReport | undefined; let failure: unknown;
    try {
      for (const lock of this.locks.values()) { try { await lock.update({ state: "stopping" }); } catch (error) { failure ??= error; } }
      try { await this.proc.rpc.send({ type: "clear_queue" }, { timeoutMs: 2000 }); } catch { /* 管道已关闭时仍执行 hostkit 的停止和身份复查。 */ }
      report = await this.proc.stop(this.options.stopOptions); await verifyStopped(this.identity, report);
      if (failure) throw failure;
      for (const lock of this.locks.values()) await lock.release(); this.locks.clear();
      await this.persistence;
      await rm(this.recordFile + ".tmp", { force: true }); await rm(this.recordFile, { force: true });
      return report;
    } catch (error) { failure = error; throw error; }
    finally {
      for (const off of this.listeners.splice(0)) off();
      this.rejectReady(new PaneError("interrupted", this.fatalReason ?? "会话已关闭", 409));
      const reason = this.fatalReason ?? (report?.steps.some((step) => step.step === "abort" && !step.ok) ? "停止超时，已强制结束进程" : "会话已关闭");
      this.callbacks.onExit(reason, report, failure); this.resolveExit();
    }
  }
}
