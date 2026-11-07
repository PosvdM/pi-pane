import { randomUUID } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";
import { readFile, readdir, rm, mkdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { stopByIdentity, probeSessionWriterLock, type ProcessIdentity, type StopReport } from "pi-hostkit";
import type { DraftNode, SessionStreamEvent, StreamCursor } from "@pi-pane/plugin-api";
import type { ControlRequest, ExtensionUiRequest } from "./pi-rpc.js";
import { AssetStore } from "./assets.js";
import { BridgeBroker } from "./bridge.js";
import { ControlQueue, RequestLedger } from "./control.js";
import { RpcSubprocessDriver, verifyStopped, type DriverHandle, type DriverOptions } from "./driver.js";
import { assert, duration, PaneError } from "./errors.js";
import { SessionModel } from "./model.js";
import { fileKey, PiStore, readSession, type Entry } from "./store.js";
import { TrustDecisions } from "./trust.js";

interface HostedSession {
  id: string; file: string; cwd: string; model: SessionModel; control: ControlQueue; handle?: DriverHandle; owner?: symbol;
  state?: any; syncing?: Promise<void>; dirty: boolean; drafts: Map<string, DraftNode[]>; clients: number; lastActive: number;
  holds: Map<string, { source: string; reason: string }>; ui: Map<string, ExtensionUiRequest>; recentExternal: boolean; closed: boolean;
}
const mutations = new Set(["prompt", "steer", "follow_up", "stop", "close", "restart", "set_model", "set_thinking_level", "compact", "new_session", "fork", "clone", "set_session_name"]);
const queries = new Set(["get_state", "get_available_models", "get_commands", "get_session_stats", "get_fork_messages", "get_last_assistant_text"]);
export interface SessionManagerOptions extends DriverOptions { idleReclaimMs?: number }
export class Sessions {
  readonly ledger: RequestLedger;
  private records = new Map<string, HostedSession>(); private files = new Map<string, HostedSession>();
  private driver: RpcSubprocessDriver; private timer: ReturnType<typeof setInterval>; private projects = new Set<string>();
  private state: Record<string, unknown> = {};
  private stateQueue = new ControlQueue();
  private recoveredFiles = new Set<string>();
  private recovering = true; private closing = false; readonly reports: StopReport[] = [];
  private starts = new Map<AbortController, Promise<void>>(); private closePromise?: Promise<void>;
  private handles = new Map<DriverHandle, Promise<void>>(); private cleanupErrors: unknown[] = [];
  readonly recoveryDiagnostics: string[] = [];
  constructor(readonly assets: AssetStore, readonly store: PiStore, readonly trust: TrustDecisions, private readonly broker: BridgeBroker, private readonly options: SessionManagerOptions,
    private readonly emitUi: (sessionId: string, request: any) => void) {
    this.ledger = new RequestLedger(Date.now, duration(options.rpcTimeoutMs, 30000));
    this.driver = new RpcSubprocessDriver(broker, { ...options, onTrust: (cwd) => trust.request(cwd) });
    this.timer = setInterval(() => { void this.reclaim().catch(() => {}); }, 10000); this.timer.unref();
  }
  async recover(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(path.join(this.options.home, "state.json"), "utf8"));
      assert(this.state && typeof this.state === "object" && !Array.isArray(this.state), "invalidState", "服务端状态文件无效", 503);
      if (Array.isArray(this.state.knownProjects)) for (const cwd of this.state.knownProjects) if (typeof cwd === "string" && path.isAbsolute(cwd)) this.projects.add(cwd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const existing = await readdir(path.join(this.options.home, "recovery"));
      for (const file of existing) if (file.endsWith(".json") || file.endsWith(".tmp")) this.recoveryDiagnostics.push(`既有写者恢复隔离记录：${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const directory = path.join(this.options.home, "run"); await mkdir(directory, { recursive: true });
    try {
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(path.join(directory, file), "utf8")) as { identity: ProcessIdentity; sessionFile: string };
        assert(record.identity && Number.isSafeInteger(record.identity.pid) && record.identity.pid > 0 && typeof record.identity.startTime === "string" && record.identity.startTime.length > 0 && typeof record.identity.runId === "string" && typeof record.identity.instanceId === "string" && typeof record.sessionFile === "string", "invalidRunRecord", "运行记录损坏，不能重新打开会话", 503);
        // 在所有恢复完成前不接受会话打开；身份查询不明或 StopReport 不完整时保留现场。
        const report = await stopByIdentity(record.identity, this.options.stopOptions); await verifyStopped(record.identity, report); this.reports.push(report);
        this.recoveredFiles.add(fileKey(record.sessionFile)); await rm(path.join(directory, file));
      }
    } catch (error) { this.cleanupErrors.push(error); throw error; }
    this.recovering = false;
  }
  setBridgeUrl(url: string): void {
    this.options.bridgeUrl = url;
    this.driver = new RpcSubprocessDriver(this.broker, { ...this.options, onTrust: (cwd) => this.trust.request(cwd) });
  }
  async reextractBlobs(): Promise<void> {
    for (const session of this.records.values()) this.assets.detach((await readSession(session.file)).entries);
  }
  private record(id: string): HostedSession { const session = this.records.get(id); assert(session, "sessionMissing", "会话不存在", 404); return session; }
  async open(input: { cwd: string; sessionFile?: string; fork?: boolean }): Promise<any> {
    assert(!this.recovering, "recovering", "旧进程尚未完成恢复", 503);
    assert(!this.closing, "serverStopping", "服务端正在关闭", 503);
    assert(typeof input.cwd === "string" && path.isAbsolute(input.cwd), "invalidCwd", "项目目录必须为绝对路径");
    const cwd = await import("node:fs/promises").then((fs) => fs.realpath(input.cwd));
    this.projects.add(cwd);
    await this.stateQueue.run(async () => {
      this.state.knownProjects = [...this.projects];
      const target = path.join(this.options.home, "state.json"); const temporary = target + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 }); await rename(temporary, target);
    });
    const directory = await this.store.sessionDir(cwd); await mkdir(directory, { recursive: true });
    let file = input.sessionFile ?? path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
    assert(path.isAbsolute(file), "invalidSessionFile", "会话文件必须为绝对路径");
    if (input.fork) file = await this.store.fork(file, cwd, directory);
    const known = this.files.get(fileKey(file)); if (known) return this.view(known);
    const parsed = await readSession(file); const id = parsed.header?.id ?? randomUUID();
    assert(typeof id === "string", "sessionIdentityConflict", "会话标识无效", 409);
    const model = new SessionModel({ source: "pane", id }, this.assets); model.reset(parsed.entries, parsed.leafId);
    const busy = await probeSessionWriterLock(file); model.readonlyReason = busy.held ? "externalWriter" : "archived";
    let recentExternal = false;
    try { recentExternal = !input.fork && !this.recoveredFiles.has(fileKey(file)) && Date.now() - (await stat(file)).mtimeMs < 60000; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // 文件读取和锁探测期间，其他请求可能已打开或托管此路径；登记前重新核对归属。
    assert(!this.closing, "serverStopping", "服务端正在关闭", 503);
    const existing = this.files.get(fileKey(file)); if (existing) return this.view(existing);
    assert(!this.records.has(id), "sessionIdentityConflict", "另一个文件使用了相同的会话标识", 409);
    const session: HostedSession = { id, file, cwd, model, control: new ControlQueue(), dirty: false, drafts: new Map(), clients: 0, lastActive: Date.now(), holds: new Map(), ui: new Map(), recentExternal, closed: false };
    this.records.set(id, session); this.files.set(fileKey(file), session);
    this.watch(file);
    return { ...this.view(session), diagnostics: parsed.diagnostics, ...(busy.held ? { heldBy: busy.record?.host.app } : {}), ...(recentExternal ? { warning: "recentModification" } : {}) };
  }
  private watch(file: string): void {
    watchFile(file, { persistent: false, interval: 500 }, (current, previous) => {
      const session = this.files.get(fileKey(file));
      if (!session || session.handle || session.closed || current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      const model = session.model; const epoch = model.epoch; const owner = session.owner;
      void readSession(file).then((parsed) => {
        if (!session.handle && !session.closed && session.owner === owner && this.files.get(fileKey(file)) === session && session.model === model && model.epoch === epoch) model.reset(parsed.entries, parsed.leafId);
      }).catch((error) => session.model.emit({ type: "pane_diagnostic", message: String(error) }));
    });
  }
  private view(session: HostedSession): any { return { ...session.model.snapshot(), cwd: session.cwd, sessionFile: session.file, projectTrusted: session.state?.projectTrusted, holds: [...session.holds.values()] }; }
  snapshot(id: string): any { return this.view(this.record(id)); }
  history(id: string, before: string, limit?: number): any { return this.record(id).model.history(before, limit); }
  async list(): Promise<any[]> { return this.store.list([...this.projects]); }
  subscribe(id: string, cursor: StreamCursor, listener: (event: SessionStreamEvent) => void): () => void {
    const session = this.record(id); session.clients++; session.lastActive = Date.now();
    const off = session.model.subscribe(cursor, listener);
    for (const request of session.ui.values()) this.emitUi(id, request);
    return () => { off(); session.clients--; session.lastActive = Date.now(); };
  }
  hold(id: string, source: string, reason: string): () => void {
    const session = this.record(id); const key = randomUUID(); session.holds.set(key, { source, reason });
    session.model.emit({ type: "pane_status", status: session.model.status, phase: session.model.inFlight.phase, controlRevision: session.model.controlRevision, holds: [...session.holds.values()] });
    return () => { session.holds.delete(key); session.lastActive = Date.now(); };
  }
  command(id: string, request: ControlRequest): Promise<any> {
    const priority = ["stop", "close", "restart"].includes(request.command?.type);
    return this.ledger.execute(request.requestId, { sessionId: id, ...request }, () => this.record(id).control.run(async (signal) => {
      let session = this.record(id); const model = session.model; const command = request.command;
      assert(command && mutations.has(command.type), "unsupportedCommand", "不支持此会话控制命令");
      assert(request.expectedEpoch === model.epoch, "epochChanged", "会话进程已更换，请重新读取快照", 409);
      assert(request.expectedRevision === model.controlRevision, "revisionChanged", "会话状态已变化，请重新确认", 409);
      session.lastActive = Date.now(); const requestedFile = fileKey(session.file);
      if (command.type === "restart") { assert(session.model.status === "interrupted", "restartNotAvailable", "只有中断的会话可以重启", 409); session.control.preempt(); if (session.handle) await session.handle.stop(); session.recentExternal = false; await this.start(session, command.assumeNoWriter === true, signal); return { status: "accepted", snapshot: this.view(session) }; }
      if (command.type === "close") {
        assert(!session.holds.size || command.confirmHolds === true, "holdsConfirmation", "会话仍有保活原因，请确认关闭", 409);
        const preempted = session.control.preempt();
        const result = await this.stop(session, true, preempted); session.holds.clear(); return result;
      }
      if (command.type === "stop") return this.stop(session, false, session.control.preempt());
      assert(model.inFlight.phase !== "stopping", "stopping", "正在停止，请稍后重试", 409);
      signal.throwIfAborted();
      if (!session.handle) await this.start(session, false, signal);
      signal.throwIfAborted();
      assert(fileKey(session.file) === requestedFile, "epochChanged", "会话启动期间已切换，请重新确认目标会话", 409);
      assert(session.handle?.acceptingInput, "bridgeNotReady", "pane-bridge 尚未就绪，不能发送输入", 409);
      let rpc = { ...command };
      if (["prompt", "steer", "follow_up"].includes(command.type)) {
        assert(!("images" in command), "invalidImages", "图片必须使用上传后的草稿节点");
        if (request.draft) {
          const encoded = this.assets.encode(request.draft, session.state?.model?.input?.includes("image") === true);
          rpc = { ...rpc, ...encoded }; session.drafts.set(encoded.message, structuredClone(request.draft));
        }
        assert(typeof rpc.message === "string" && Buffer.byteLength(rpc.message) <= 1024 * 1024, "invalidMessage", "消息文本无效或超过 1 MiB");
      }
      // 受理控制操作只递增 revision；生成阶段由真实事件驱动，handled/拒绝不推测为 streaming。
      model.control(model.status, model.inFlight.phase, undefined, true);
      const handle = session.handle;
      const response = await handle.send(rpc, { trackResult: true });
      session = this.files.get(fileKey(handle.sessionFile)) ?? session;
      if (session.handle !== handle) return { status: "accepted", response, snapshot: this.view(session) };
      try {
        await this.sync(session);
        if (["set_model", "set_thinking_level", "compact"].includes(command.type) && session.handle?.acceptingInput) {
          const currentModel = session.model; const epoch = currentModel.epoch; const currentHandle = session.handle;
          const state = (await currentHandle.send({ type: "get_state" })).data as any;
          if (session.handle === currentHandle && currentHandle.acceptingInput && session.model === currentModel && currentModel.epoch === epoch) {
            session.state = state;
            if (command.type === "compact" && !state.isCompacting && !state.isStreaming) currentModel.control("idle", "idle");
          }
        }
      } catch (error) {
        // 控制响应已经确认；后续快照查询失败不能把已执行操作缓存为失败。
        session.model.emit({ type: "pane_diagnostic", message: String(error) });
      }
      return { status: "accepted", response, snapshot: this.view(session) };
    }, priority), priority);
  }
  async query(id: string, type: string): Promise<any> {
    assert(queries.has(type), "unsupportedQuery", "不支持此会话查询"); const session = this.record(id);
    assert(session.handle?.acceptingInput, "notHosted", "会话尚未托管", 409); return session.handle.send({ type });
  }
  respondUi(id: string, body: any): any {
    const session = this.record(id); assert(body.expectedEpoch === session.model.epoch, "epochChanged", "会话进程已更换", 409);
    if (!session.ui.has(body.id)) return { status: "alreadyHandled" };
    session.handle!.respondUi(body.response ? { ...body.response, id: body.id } : { id: body.id, cancelled: true }); session.ui.delete(body.id); return { status: "done" };
  }
  private start(session: HostedSession, assumeNoWriter = false, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(new PaneError("interrupted", "会话已关闭", 409));
    const controller = new AbortController(); const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // 信任询问及目录读取也属于启动；登记后才进入第一个异步步骤。
    const operation = Promise.resolve().then(() => this.performStart(session, assumeNoWriter, cancellation));
    const settled = operation.catch((error) => { if (controller.signal.aborted && error !== cancellation.reason) throw error; });
    this.starts.set(controller, settled);
    void settled.then(() => this.starts.delete(controller), () => this.starts.delete(controller));
    return operation;
  }
  private async performStart(session: HostedSession, assumeNoWriter: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    assert(!session.recentExternal, "recentModification", "该会话可能正在别处运行，请只读查看或 Fork 为新会话", 409);
    await this.trust.request(session.cwd);
    signal?.throwIfAborted();
    const sessionDir = await this.store.sessionDir(session.cwd);
    signal?.throwIfAborted(); assert(!this.closing && !session.closed, "interrupted", "会话已关闭", 409);
    const owner = Symbol(); session.owner = owner;
    let attached = session; let handle: DriverHandle | undefined;
    const cancel = () => { void handle?.stop().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      handle = await this.driver.start({ cwd: session.cwd, sessionFile: session.file, sessionDir, decisions: this.trust.config(), assumeNoWriter }, {
        onCleanupFailure: (error) => { this.cleanupErrors.push(error); },
        onHandle: (source) => {
          handle = source;
          // 退出回调会摘下会话 handle；迟到目标取锁及初始化仍由独立的排空记录覆盖。
          const finished = source.exited.then(() => source.drain()); this.handles.set(source, finished);
          void finished.then(() => this.handles.delete(source), () => {});
          if (signal.aborted || this.closing || attached.owner !== owner || attached.closed) cancel();
          else attached.handle = source;
        },
        onRecord: (event) => { if (attached.owner === owner && !attached.closed) this.receive(attached, event); },
        onReady: (state, data, reason, source) => {
          if (this.closing || attached.owner !== owner || attached.closed || attached.handle && attached.handle !== source) return;
          // bridge 就绪可能先于 start 返回；回调携带来源 handle，绑定不能读取另一代的写者。
          attached.handle = source; attached = this.rebind(attached, source, state, data, reason);
        },
        onExit: (reason, report, error) => {
          const session = attached;
          if (session.owner !== owner) return;
          if (report) this.reports.push(report);
          session.owner = undefined; session.handle = undefined; session.ui.clear();
          if (reason === "会话已关闭" && !error) {
            session.model.readonly = true; session.model.readonlyReason = "archived"; session.model.inFlight.assistant = undefined; session.model.inFlight.tools = [];
            session.model.control("idle", "idle", reason, true);
          } else session.model.interrupt("pi", `${reason}${error ? `：${String(error)}` : ""}`);
          session.lastActive = Date.now(); session.recentExternal = false;
        },
      }, signal);
      // 启动跨越取锁、spawn 和 bridge 就绪；停止抢占后，迟到的 handle 必须先结束，不能再发送输入。
      if (this.closing || attached.owner !== owner || attached.closed) { await handle.stop(); await handle.ready; throw new PaneError("interrupted", "会话已关闭", 409); }
      attached.handle = handle;
      signal.throwIfAborted();
      await handle.ready;
      signal.throwIfAborted();
      assert(!this.closing && attached.owner === owner && attached.handle === handle && !attached.closed, "interrupted", "会话写者已停止或更换", 409);
    } catch (error) {
      // ready 可以先于停止流程失败；对外返回启动失败前，等待身份复查和写锁处理完成。
      if (handle) { await handle.stop(); await handle.drain(); }
      if (attached.owner === owner) {
        if (error instanceof PaneError && error.code === "externalWriter") attached.model.readonlyReason = "externalWriter";
        else if (attached.model.status !== "interrupted") attached.model.interrupt("startup", String(error));
      }
      if (this.closing && signal.aborted && handle) signal.throwIfAborted();
      throw error;
    } finally { signal.removeEventListener("abort", cancel); }
  }
  private rebind(session: HostedSession, handle: DriverHandle, state: any, data: any, reason: string): HostedSession {
    assert(session.handle === handle, "staleDriver", "会话写者已更换，忽略旧写者的重绑定", 409);
    const old = session.model; const changed = state.sessionId !== session.id || fileKey(state.sessionFile) !== fileKey(session.file);
    if (changed) {
      old.emit({ type: "pane_session_replaced", newRef: { source: "pane", id: state.sessionId }, reason: reason === "startup" ? "new" : reason });
      old.readonly = true; old.readonlyReason = "archived"; old.control("idle", "idle", undefined, true);
      const target = this.files.get(fileKey(state.sessionFile));
      if (target && target !== session) {
        assert(target.id === state.sessionId && !target.handle && !target.control.busy, "sessionIdentityConflict", "目标会话身份冲突、已被托管或正在处理控制操作", 409);
        // 保留目标对象及模型；控制队列随写者迁移，切换后仍挂起的 RPC 必须能被目标会话停止。
        target.control = session.control; session.control = new ControlQueue();
        target.owner = session.owner; target.handle = handle; session.owner = undefined; session.handle = undefined; session.ui.clear(); session.dirty = false;
        session = target;
      } else {
        const previous: HostedSession = { ...session, handle: undefined, owner: undefined, syncing: undefined, dirty: false, drafts: new Map(), control: new ControlQueue(), holds: new Map(), ui: new Map(), recentExternal: false };
        this.records.set(session.id, previous); this.files.set(fileKey(session.file), previous);
        session.id = state.sessionId; session.file = state.sessionFile; session.model = new SessionModel({ source: "pane", id: state.sessionId }, this.assets);
        this.records.set(session.id, session); this.files.set(fileKey(session.file), session); this.watch(session.file);
      }
    }
    session.state = state; session.cwd = state.cwd ?? session.cwd; session.model.readonly = false; session.model.readonlyReason = undefined;
    session.model.reset(data.entries as Entry[], data.leafId); session.model.control("idle", "idle", undefined, true); session.recentExternal = false;
    return session;
  }
  private receive(session: HostedSession, event: any): void {
    session.lastActive = Date.now();
    if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) session.ui.set(event.id, event);
      this.emitUi(session.id, event); return;
    }
    session.model.apply(event);
    if (["message_end", "entry_appended", "compaction_end", "session_info_changed", "agent_settled"].includes(event.type)) void this.sync(session).catch((error) => session.model.emit({ type: "pane_diagnostic", message: String(error) }));
  }
  private sync(session: HostedSession): Promise<void> {
    session.dirty = true;
    if (session.syncing) return session.syncing;
    session.syncing = (async () => {
      while (session.dirty && session.handle?.acceptingInput) {
        session.dirty = false; const model = session.model; const epoch = model.epoch; const since = model.entries.at(-1)?.id; const handle = session.handle;
        const response = await handle.send({ type: "get_entries", ...(since ? { since } : {}) });
        if (epoch !== model.epoch || session.model !== model || session.handle !== handle) continue;
        const data = response.data as any; model.append(data.entries, data.leafId);
      }
    })().finally(() => { session.syncing = undefined; });
    return session.syncing;
  }
  private async stop(session: HostedSession, close: boolean, preempted = false): Promise<any> {
    if (!session.handle) return { status: "nothingToStop" };
    const handle = session.handle;
    session.model.control("running", "stopping", undefined, true);
    let cleared: any = { steering: [], followUp: [] }; let report: StopReport | undefined;
    try {
      const response = await handle.send({ type: "clear_queue" }, { timeoutMs: 2000 }); cleared = response.data;
      if (close) report = await handle.stop();
      else {
        try {
          await handle.send({ type: "abort" }, { timeoutMs: this.options.stopOptions?.abortTimeoutMs ?? 10000 });
          // abort 的响应不能证明挂起的扩展命令已结束；抢占时关闭进程才能结束全部底层等待项。
          if (preempted) report = await handle.stop();
          else if (session.handle === handle && handle.acceptingInput) { session.model.control("idle", "idle"); await this.sync(session); }
        }
        catch { report = await handle.stop(); }
      }
    } catch { report = await handle.stop(); }
    const texts: string[] = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])];
    const drafts = texts.map((text) => session.drafts.get(text) ?? [{ type: "text", text }]);
    if (!session.handle || session.handle === handle) for (const text of texts) session.drafts.delete(text);
    return { status: "done", clearedText: texts, clearedDrafts: drafts, ...(report ? { stopReport: report } : {}) };
  }
  private async reclaim(): Promise<void> {
    for (const session of this.records.values()) if (session.handle && session.model.status === "idle" && !session.clients && !session.holds.size && !session.ui.size && Date.now() - session.lastActive >= (this.options.idleReclaimMs ?? 1800000)) await this.stop(session, true);
  }
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.performClose();
    return this.closePromise;
  }
  private async performClose(): Promise<void> {
    this.closing = true; clearInterval(this.timer); this.trust.close(); const errors: unknown[] = [];
    const starts = [...this.starts];
    for (const [controller] of starts) controller.abort(new PaneError("interrupted", "会话已关闭", 409));
    for (const session of this.records.values()) {
      session.closed = true; unwatchFile(session.file);
      const handle = session.handle;
      if (handle) try { await handle.stop(); await handle.drain(); } catch (error) { errors.push(error); }
    }
    for (const result of await Promise.allSettled(starts.map(([, settled]) => settled))) if (result.status === "rejected") errors.push(result.reason);
    for (const [handle, finished] of this.handles) try { await handle.stop(); await finished; } catch (error) { errors.push(error); }
    // 仅汇总本实例产生的恢复失败；既有隔离记录留作诊断，不阻止正常关闭。
    errors.push(...this.cleanupErrors);
    if (errors.length) throw new AggregateError(errors, "部分会话未确认停止");
  }
}
