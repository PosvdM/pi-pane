import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock, currentProcessIdentity, isSameProcess, isSessionWriterLock,
  type Containment, type ExtensionUiResponse, type ManagedProcess, type PiInstall, type ProcessIdentity,
  type RpcCommand, type RpcResponse, type SessionWriterLock, type StopOptions, type StopReport } from "pi-hostkit";
import { BridgeBroker, type TrustChoice } from "./bridge.js";
import { assert, duration, PaneError } from "./errors.js";
import { fileKey } from "./store.js";

export interface DriverSpec { cwd: string; sessionFile: string; sessionDir: string; decisions: Record<string, TrustChoice>; assumeNoWriter?: boolean }
export interface DriverOptions {
  home: string; instanceId: string; pi: PiInstall; bridgeUrl: string; extensionPath: string;
  env?: Record<string, string>; extraExtensions?: string[]; containment?: Containment;
  readyTimeoutMs?: number; rpcTimeoutMs?: number; stopOptions?: StopOptions;
  onTrust?: (cwd: string) => Promise<TrustChoice | undefined>;
}
export interface DriverCallbacks {
  onRecord(event: any): void;
  onReady(state: any, entries: any, reason: string): void;
  onExit(reason: string, report?: StopReport, error?: unknown): void;
}
export interface SessionDriver { start(spec: DriverSpec, callbacks: DriverCallbacks): Promise<DriverHandle> }
export interface DriverHandle {
  readonly identity: ProcessIdentity; readonly ready: Promise<void>; readonly exited: Promise<void>; readonly sessionFile: string;
  readonly acceptingInput: boolean;
  send(command: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse>;
  respondUi(response: ExtensionUiResponse): void;
  stop(): Promise<StopReport>;
}
export function checkStopReport(report: StopReport): void {
  assert(["job_object", "cgroup", "snapshot_visible"].includes(report.coverage), "stopCoverage", "停止报告的覆盖范围无效", 503);
  assert(!report.leftovers.length && !report.steps.some((step) => !step.ok && ["snapshot", "snapshot cleanup", "verify"].includes(step.step)), "stopIncomplete", "仍有存活或无法确认退出的进程，保留写锁", 503);
}
export async function verifyStopped(identity: ProcessIdentity, report: StopReport): Promise<void> {
  checkStopReport(report);
  assert(await isSameProcess(identity) === "gone", "stopIncomplete", "pi 尚未确认退出，保留写锁", 503);
}
export class RpcSubprocessDriver implements SessionDriver {
  constructor(private readonly broker: BridgeBroker, private readonly options: DriverOptions) { duration(options.readyTimeoutMs, 10000); }
  async start(spec: DriverSpec, callbacks: DriverCallbacks): Promise<DriverHandle> {
    const lock = await acquireSessionWriterLock(spec.sessionFile, { app: "pi-pane", identity: currentProcessIdentity(this.options.instanceId) });
    assert(isSessionWriterLock(lock), "externalWriter", "会话已由其他宿主托管，只能只读打开", 409);
    if (await lock.recoverPreviousWriter({ ...this.options.stopOptions, assumeNoWriter: spec.assumeNoWriter }) === "failed") throw new PaneError("recoveryFailed", "上一个写者状态不明，请确认没有遗留的 pi 后重试", 409);
    for (const report of lock.recoveryReports) { try { checkStopReport(report); } catch (error) { await lock.release(); throw error; } }
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
      proc = await lock.spawnWriter({ argv, cwd: spec.cwd, env, runId: randomUUID(), instanceId: this.options.instanceId, containment: this.options.containment });
      launch.attach(proc.identity);
    } catch (error) {
      launch.close(); await lock.release(); throw error;
    }
    handle = new RpcHandle(proc, lock, launch.close, spec, callbacks, this.options); attachHandle();
    try { await handle.persist(); return handle; }
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
  private readonly recordFile: string;
  constructor(private readonly proc: ManagedProcess, lock: SessionWriterLock, private readonly revoke: () => void,
    private readonly spec: DriverSpec, private readonly callbacks: DriverCallbacks, private readonly options: DriverOptions) {
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
  async persist(): Promise<void> {
    const data = JSON.stringify({ identity: this.identity, sessionFile: this.sessionFile, cwd: this.spec.cwd });
    await mkdir(path.dirname(this.recordFile), { recursive: true });
    const temp = this.recordFile + ".tmp"; await writeFile(temp, data, { mode: 0o600 }); await rename(temp, this.recordFile);
  }
  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("pane-bridge 就绪超时，请重启会话"), duration(this.options.readyTimeoutMs, 10000)); this.timer.unref();
  }
  private async target(file: string): Promise<boolean> {
    const key = fileKey(file); if (this.locks.has(key)) return true;
    const lock = await acquireSessionWriterLock(file, { app: "pi-pane", identity: currentProcessIdentity(this.options.instanceId) });
    if (!isSessionWriterLock(lock)) return false;
    if (await lock.recoverPreviousWriter(this.options.stopOptions) === "failed") return false;
    // 保留每个已取得的目标锁，直到 session_start 确认切走或写者停止。
    this.locks.set(key, lock);
    await lock.update({ writer: this.identity, state: "running" }); return true;
  }
  async bridgeEvent(event: any): Promise<any> {
    assert(!this.stopping, "bridgeStopping", "会话正在停止", 409);
    switch (event.type) {
      case "trust": return { decision: await this.options.onTrust?.(event.cwd) };
      case "beforeFork": return { accepted: true };
      case "lock": {
        assert(typeof event.target === "string" && path.isAbsolute(event.target), "invalidTarget", "会话目标必须是绝对路径");
        return { acquired: await this.target(event.target) };
      }
      case "shutdown": {
        if (event.reason === "quit") { this.enabled = false; return { accepted: true }; }
        this.enabled = false; this.generation++; this.armTimeout();
        if (typeof event.target === "string") {
          this.pendingTarget = event.target;
          try { if (!await this.target(event.target)) this.switchFailure = new Error("目标会话正被别处托管"); }
          catch (error) { this.switchFailure = error; }
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
            assert(fileKey(state.data.sessionFile) === fileKey(event.sessionFile) && state.data.sessionId === event.sessionId, "readyMismatch", "pane-bridge 与 RPC 的会话身份不符");
            const entries = await this.raw({ type: "get_entries" });
            if (this.stopping || generation !== this.generation) return;
            for (const [key, lock] of this.locks) if (lock !== destination) { await lock.release({ writerSwitchedAway: true }); this.locks.delete(key); }
            this.current = destination; this.pendingTarget = undefined;
            await this.persist();
            this.callbacks.onReady({ ...state.data, projectTrusted: event.trusted, cwd: event.cwd }, entries.data, event.reason);
            this.enabled = true; this.started = true; clearTimeout(this.timer); this.resolveReady();
          }).catch((error) => this.fail("pane-bridge 重绑定失败", error));
        });
        return { accepted: true };
      }
      default: throw new PaneError("unknownBridgeEvent", "不支持此 pane-bridge 请求");
    }
  }
  private raw(command: RpcCommand, timeoutMs = this.options.rpcTimeoutMs ?? 30000): Promise<any> {
    return this.proc.rpc.send(command, { timeoutMs }).then((response) => { assert(response.success, "rpcRejected", response.error ?? "pi 拒绝命令", 409); return response; });
  }
  async send(command: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse> {
    assert(this.acceptingInput, "bridgeNotReady", "pane-bridge 尚未就绪或会话正在停止", 409);
    const response = await this.raw(command, opts?.timeoutMs);
    if (["prompt", "new_session", "fork", "clone"].includes(command.type) && this.enabled && !this.pendingTarget && this.locks.size > 1) {
      const state = await this.raw({ type: "get_state" });
      if (fileKey(state.data.sessionFile) === fileKey(this.current.sessionFile)) {
        for (const [key, lock] of this.locks) if (lock !== this.current) { await lock.release({ writerSwitchedAway: true }); this.locks.delete(key); }
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
  private async performStop(): Promise<StopReport> {
    let report: StopReport | undefined; let failure: unknown;
    try {
      for (const lock of this.locks.values()) { try { await lock.update({ state: "stopping" }); } catch (error) { failure ??= error; } }
      try { await this.proc.rpc.send({ type: "clear_queue" }, { timeoutMs: 2000 }); } catch { /* 管道已关闭时仍执行 hostkit 的停止和身份复查。 */ }
      report = await this.proc.stop(this.options.stopOptions); await verifyStopped(this.identity, report);
      if (failure) throw failure;
      for (const lock of this.locks.values()) await lock.release(); this.locks.clear();
      await rm(this.recordFile, { force: true });
      return report;
    } catch (error) { failure = error; throw error; }
    finally {
      for (const off of this.listeners.splice(0)) off();
      this.rejectReady(new PaneError("interrupted", this.fatalReason ?? "会话已关闭", 409));
      this.callbacks.onExit(this.fatalReason ?? "会话已关闭", report, failure); this.resolveExit();
    }
  }
}
