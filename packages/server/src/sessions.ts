import { randomUUID } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";
import { readFile, readdir, rm, mkdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { stopByIdentity, probeSessionWriterLock, type ProcessIdentity, type StopReport } from "pi-hostkit";
import type { DraftNode, SessionStreamEvent, StreamCursor } from "@pi-pane/plugin-api";
import type { ControlRequest } from "./pi-rpc.js";
import type { PaneSessionList, PaneSessionView, PaneQueryResults, PaneQueryType, PaneUiAnswerRequest, PaneUiAnswerResult, PaneUiRequest, PaneServerMessage } from "./web-api.js";
import { isPaneQueryType, isUiDialog, queryCommands, toPaneOutcome, toPaneQuery, toPaneSessionListItem, toPaneState, toPaneUiRequest, toPiControlCommand, toPiUiAnswer, type PaneUiDialog } from "./web-adapter.js";
import { ExportStore } from "./exports.js";
import { terminalOnlyCommand } from "./pi-commands.js";
import { AssetStore } from "./assets.js";
import { BridgeBroker } from "./bridge.js";
import { ControlQueue, RequestLedger } from "./control.js";
import { RpcSubprocessDriver, verifyStopped, type DriverHandle, type DriverOptions } from "./driver.js";
import { assert, duration, PaneError } from "./errors.js";
import { SessionModel } from "./model.js";
import { fileKey, PiStore, readSession, type Entry } from "./store.js";
import { TrustDecisions } from "./trust.js";
import { observeHostkit } from "./hostkit-cleanup.js";

interface HostedSession {
  id: string; file: string; cwd: string; model: SessionModel; control: ControlQueue; handle?: DriverHandle; owner?: symbol;
  state?: any; syncing?: Promise<void>; dirty: boolean; drafts: Map<string, DraftNode[]>; clients: number; lastActive: number;
  holds: Map<string, { source: string; reason: string }>; ui: Map<string, { request: PaneUiDialog; timer?: ReturnType<typeof setTimeout> }>; recentExternal: boolean; closed: boolean;
}
const mutations = new Set(["prompt", "steer", "follow_up", "stop", "close", "restart", "set_model", "set_thinking_level", "compact", "new_session", "fork", "clone", "set_session_name", "export"]);
export interface SessionManagerOptions extends DriverOptions { idleReclaimMs?: number }
export class Sessions {
  readonly ledger: RequestLedger;
  readonly exports: ExportStore;
  private records = new Map<string, HostedSession>(); private files = new Map<string, HostedSession>();
  private driver: RpcSubprocessDriver; private timer: ReturnType<typeof setInterval>; private projects = new Set<string>();
  private state: Record<string, unknown> = {};
  private stateQueue = new ControlQueue();
  private recoveredFiles = new Set<string>();
  private stateRefreshes = new WeakMap<HostedSession, { handle: DriverHandle; model: SessionModel; epoch: string; dirty: boolean; promise: Promise<void> }>();
  private recovering = true; private closing = false; readonly reports: StopReport[] = [];
  private starts = new Map<AbortController, Promise<void>>(); private closePromise?: Promise<void>;
  private handles = new Map<DriverHandle, Promise<void>>(); private cleanupErrors: unknown[] = [];
  private readonly closeTimeoutMs: number;
  readonly recoveryDiagnostics: string[] = [];
  constructor(readonly assets: AssetStore, readonly store: PiStore, readonly trust: TrustDecisions, private readonly broker: BridgeBroker, private readonly options: SessionManagerOptions,
    private readonly emitUi: (sessionId: string, request: PaneUiRequest) => void,
    private readonly emitUiResolved: (sessionId: string, id: string, reason: Extract<PaneServerMessage, { type: "ui_resolved" }>["reason"]) => void = () => {}) {
    this.exports = new ExportStore(options.home);
    const waits = [options.stopOptions?.abortTimeoutMs ?? 10000, options.stopOptions?.graceMs ?? 5000, options.stopOptions?.termGraceMs ?? 3000];
    assert(waits.every(ms => Number.isFinite(ms) && ms >= 0), "invalidConfig", "停止宽限必须为非负有限毫秒");
    // 与固定 hostkit 的 StopOptions 默认值一致；clear_queue 2 秒，身份核查及清理另留 5 秒。
    this.closeTimeoutMs = duration(Math.ceil(waits.reduce((sum, ms) => sum + ms, 7000)), 25000);
    this.ledger = new RequestLedger(Date.now, duration(options.rpcTimeoutMs, 30000));
    this.driver = new RpcSubprocessDriver(broker, { ...options, onTrust: (cwd) => trust.request(cwd) });
    this.timer = setInterval(() => { void this.reclaim().catch(() => {}); }, 10000); this.timer.unref();
  }
  get inflight() { return this.broker.inflight; }
  recordCleanupFailure(error: unknown): void { this.cleanupErrors.push(error); }
  recover(): Promise<void> { return this.inflight.run("sessions.recover", () => this.performRecover()); }
  private async performRecover(): Promise<void> {
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
        this.inflight.assertCleanupAllowed();
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
  open(input: { cwd: string; sessionFile?: string; fork?: boolean }): Promise<any> {
    return this.inflight.run("sessions.open", () => this.performOpen(input));
  }
  private async performOpen(input: { cwd: string; sessionFile?: string; fork?: boolean }): Promise<any> {
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
    // probe 内部短暂持锁，固定 hostkit 的 finally 释放失败没有独立标识；拒绝时保守保留。
    const busy = await observeHostkit(() => probeSessionWriterLock(file), (error) => this.recordCleanupFailure(error), true); model.readonlyReason = busy.held ? "externalWriter" : "archived";
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
  private view(session: HostedSession): PaneSessionView {
    return { ...session.model.snapshot(), cwd: session.cwd, sessionFile: session.file, hosted: session.handle?.acceptingInput === true,
      ...(session.state ? { state: toPaneState(session.state) } : {}), projectTrusted: session.state?.projectTrusted, holds: [...session.holds.values()] };
  }
  snapshot(id: string): PaneSessionView { return this.view(this.record(id)); }
  history(id: string, before: string, limit?: number): any { return this.record(id).model.history(before, limit); }
  async list(): Promise<PaneSessionList> {
    const rows = await this.store.list([...this.projects]);
    return { sessions: rows.map(row => {
      const session = this.files.get(fileKey(row.path));
      return toPaneSessionListItem(row, session?.handle?.acceptingInput === true, session?.model.status);
    }) };
  }
  subscribe(id: string, cursor: StreamCursor, listener: (event: SessionStreamEvent) => void, onUi = (request: PaneUiRequest) => this.emitUi(id, request)): () => void {
    const session = this.record(id); session.clients++; session.lastActive = Date.now();
    const off = session.model.subscribe(cursor, listener);
    for (const [uiId, pending] of session.ui) {
      if (this.uiExpired(pending.request)) this.resolveUi(session, uiId, "expired");
      else onUi(pending.request);
    }
    return () => { off(); session.clients--; session.lastActive = Date.now(); };
  }
  hold(id: string, source: string, reason: string): () => void {
    const session = this.record(id); const key = randomUUID(); session.holds.set(key, { source, reason });
    session.model.emit({ type: "pane_status", status: session.model.status, phase: session.model.inFlight.phase, controlRevision: session.model.controlRevision, holds: [...session.holds.values()] });
    return () => { session.holds.delete(key); session.lastActive = Date.now(); };
  }
  command(id: string, request: ControlRequest): Promise<any> {
    const priority = ["stop", "close", "restart"].includes(request.command?.type);
    return this.ledger.execute(request.requestId, { sessionId: id, ...request }, () => this.inflight.run("sessions.command", () => this.record(id).control.run(async (signal) => {
      let session = this.record(id); const model = session.model; const command = request.command;
      assert(command && mutations.has(command.type), "unsupportedCommand", "不支持此会话控制命令");
      let rpc = toPiControlCommand(command);
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
      let encoded: ReturnType<AssetStore["encode"]> | undefined;
      if (["prompt", "steer", "follow_up"].includes(command.type)) {
        assert(!("images" in command), "invalidImages", "图片必须使用上传后的草稿节点");
        // 编码后检查实际发送的文本；模型图片能力在启动并读取状态后校验。
        if (request.draft) { encoded = this.assets.encode(request.draft, true); rpc = { ...rpc, ...encoded }; }
        assert(typeof rpc.message === "string" && Buffer.byteLength(rpc.message) <= 1024 * 1024, "invalidMessage", "消息文本无效或超过 1 MiB");
        const name = terminalOnlyCommand(rpc.message);
        if (name) {
          const handle = session.handle;
          let available = false;
          if (handle?.acceptingInput) {
            const response = await handle.send({ type: "get_commands" });
            signal.throwIfAborted();
            assert(session.handle === handle && handle.acceptingInput && session.model === model && model.epoch === request.expectedEpoch, "epochChanged", "会话进程已更换，请重新读取快照", 409);
            assert(response.success, "rpcRejected", response.error ?? "pi 拒绝查询", 409);
            available = toPaneQuery("commands", response.data).commands.some(candidate => candidate.name === name);
          }
          assert(available, "unsupportedCommand", `pi-pane 不支持 /${name}，请在终端中使用 pi`);
        }
      }
      if (!session.handle) await this.start(session, false, signal);
      signal.throwIfAborted();
      assert(fileKey(session.file) === requestedFile, "epochChanged", "会话启动期间已切换，请重新确认目标会话", 409);
      assert(session.handle?.acceptingInput, "bridgeNotReady", "pane-bridge 尚未就绪，不能发送输入", 409);
      if (encoded) {
        assert(!encoded.images.length || session.state?.model?.input?.includes("image") === true, "imageUnsupported", "当前模型不支持图片，请切换模型");
        session.drafts.set(encoded.message, structuredClone(request.draft!));
      }
      let exported: Awaited<ReturnType<ExportStore["allocate"]>> | undefined;
      if (command.type === "export") {
        exported = await this.exports.allocate(); signal.throwIfAborted();
        rpc = { type: "export_html", outputPath: exported.outputPath };
      }
      // 受理控制操作只递增 revision；生成阶段由真实事件驱动，handled/拒绝不推测为 streaming。
      model.control(model.status, model.inFlight.phase, undefined, true);
      const handle = session.handle;
      const response = await handle.send(rpc, { trackResult: true });
      assert(response.success, "rpcRejected", response.error ?? "pi 拒绝命令", 409);
      const result = exported ? { exportId: exported.id } : toPaneOutcome(command.type, response.data);
      if (exported) this.exports.complete(exported.id);
      session = this.files.get(fileKey(handle.sessionFile)) ?? session;
      if (session.handle !== handle) return { status: "accepted", ...(result ? { result } : {}), snapshot: this.view(session) };
      try {
        await this.sync(session);
        if (["set_model", "set_thinking_level", "set_session_name", "compact"].includes(command.type) && session.handle?.acceptingInput) {
          const currentModel = session.model; const epoch = currentModel.epoch; const currentHandle = session.handle;
          await this.refreshState(session);
          if (session.handle === currentHandle && currentHandle.acceptingInput && session.model === currentModel && currentModel.epoch === epoch) {
            if (command.type === "compact" && !session.state.isCompacting && !session.state.isStreaming) currentModel.control("idle", "idle");
          }
        }
      } catch (error) {
        // 控制响应已经确认；后续快照查询失败不能把已执行操作缓存为失败。
        session.model.emit({ type: "pane_diagnostic", message: String(error) });
      }
      return { status: "accepted", ...(result ? { result } : {}), snapshot: this.view(session) };
    }, priority)), priority);
  }
  async query(id: string, type: string): Promise<PaneQueryResults[PaneQueryType]> {
    assert(isPaneQueryType(type), "unsupportedQuery", "不支持此会话查询"); const session = this.record(id);
    assert(session.handle?.acceptingInput, "notHosted", "会话尚未托管", 409);
    const handle = session.handle; const model = session.model; const epoch = model.epoch;
    const response = await handle.send({ type: queryCommands[type] });
    assert(response.success, "rpcRejected", response.error ?? "pi 拒绝查询", 409);
    if (type === "state" && session.handle === handle && handle.acceptingInput && session.model === model && model.epoch === epoch) this.commitState(session, response.data);
    return toPaneQuery(type, response.data);
  }
  respondUi(id: string, body: PaneUiAnswerRequest): PaneUiAnswerResult {
    const session = this.record(id); assert(body.expectedEpoch === session.model.epoch, "epochChanged", "会话进程已更换", 409);
    const pending = session.ui.get(body.id);
    if (!pending) return { status: "alreadyHandled" };
    if (this.uiExpired(pending.request)) { this.resolveUi(session, body.id, "expired"); return { status: "alreadyHandled" }; }
    assert(!("response" in body), "invalidUiAnswer", "对话框回答需要使用 answer 字段");
    const response = toPiUiAnswer(pending.request, body.answer);
    session.handle!.respondUi(response);
    this.resolveUi(session, body.id, body.answer === undefined ? "cancelled" : "answered"); return { status: "done" };
  }
  private uiExpired(request: PaneUiDialog): boolean { return request.expiresAt !== undefined && Date.parse(request.expiresAt) <= Date.now(); }
  private resolveUi(session: HostedSession, id: string, reason: Extract<PaneServerMessage, { type: "ui_resolved" }>["reason"]): void {
    const pending = session.ui.get(id); if (!pending) return;
    clearTimeout(pending.timer); session.ui.delete(id); this.emitUiResolved(session.id, id, reason);
  }
  private closeUi(session: HostedSession): void { for (const id of session.ui.keys()) this.resolveUi(session, id, "closed"); }
  private scheduleUi(session: HostedSession, request: PaneUiDialog): void {
    if (!request.expiresAt) return;
    const pending = session.ui.get(request.id)!;
    const check = () => {
      if (session.ui.get(request.id) !== pending) return;
      if (this.uiExpired(request)) this.resolveUi(session, request.id, "expired");
      else { pending.timer = setTimeout(check, Math.min(2 ** 31 - 1, Date.parse(request.expiresAt!) - Date.now())); pending.timer.unref(); }
    };
    check();
  }
  private start(session: HostedSession, assumeNoWriter = false, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(new PaneError("interrupted", "会话已关闭", 409));
    const controller = new AbortController(); const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // 信任询问及目录读取也属于启动；登记后才进入第一个异步步骤。
    const operation = this.inflight.run("sessions.start", () => Promise.resolve().then(() => this.performStart(session, assumeNoWriter, cancellation)));
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
          session.owner = undefined; session.handle = undefined; this.closeUi(session);
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
    if (changed || reason === "reload") this.closeUi(session);
    if (changed) {
      old.emit({ type: "pane_session_replaced", newRef: { source: "pane", id: state.sessionId }, reason: reason === "startup" ? "new" : reason });
      old.readonly = true; old.readonlyReason = "archived"; old.control("idle", "idle", undefined, true);
      const target = this.files.get(fileKey(state.sessionFile));
      if (target && target !== session) {
        assert(target.id === state.sessionId && !target.handle && !target.control.busy, "sessionIdentityConflict", "目标会话身份冲突、已被托管或正在处理控制操作", 409);
        // 保留目标对象及模型；控制队列随写者迁移，切换后仍挂起的 RPC 必须能被目标会话停止。
        target.control = session.control; session.control = new ControlQueue();
        target.owner = session.owner; target.handle = handle; session.owner = undefined; session.handle = undefined; session.dirty = false;
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
      const request = toPaneUiRequest(event, Date.now()); if (!request) return;
      if (isUiDialog(request)) {
        this.resolveUi(session, request.id, "closed"); session.ui.set(request.id, { request });
        this.emitUi(session.id, request); this.scheduleUi(session, request);
      } else this.emitUi(session.id, request);
      return;
    }
    session.model.apply(event);
    if (["session_info_changed", "model_select", "thinking_level_select", "model_changed", "thinking_level_changed"].includes(event.type)) void this.refreshState(session).catch((error) => session.model.emit({ type: "pane_diagnostic", message: String(error) }));
    if (["message_end", "entry_appended", "compaction_end", "session_info_changed", "agent_settled"].includes(event.type)) void this.sync(session).catch((error) => session.model.emit({ type: "pane_diagnostic", message: String(error) }));
  }
  private commitState(session: HostedSession, state: any): void {
    const previous = session.state;
    const changed = previous?.sessionName !== state.sessionName || previous?.thinkingLevel !== state.thinkingLevel || JSON.stringify(previous?.model) !== JSON.stringify(state.model);
    session.state = state;
    if (changed) session.model.control(session.model.status, session.model.inFlight.phase, undefined, true);
  }
  private refreshState(session: HostedSession): Promise<void> {
    const handle = session.handle; const model = session.model; const epoch = model.epoch;
    if (!handle?.acceptingInput || session.closed) return Promise.resolve();
    const pending = this.stateRefreshes.get(session);
    if (pending?.handle === handle && pending.model === model && pending.epoch === epoch) {
      pending.dirty = true; return pending.promise;
    }
    const current = () => session.handle === handle && handle.acceptingInput && session.model === model && model.epoch === epoch && !session.closed;
    const job = { handle, model, epoch, dirty: true, promise: Promise.resolve() };
    // 同一轮事件合并查询；查询期间的变化只追加一次刷新，不阻塞事件接收。
    job.promise = Promise.resolve().then(async () => {
      while (job.dirty && current()) {
        job.dirty = false;
        const response = await handle.send({ type: "get_state" });
        assert(response.success, "rpcRejected", response.error ?? "pi 拒绝查询", 409);
        if (current()) this.commitState(session, response.data);
      }
    }).finally(() => { if (this.stateRefreshes.get(session) === job) this.stateRefreshes.delete(session); });
    this.stateRefreshes.set(session, job);
    return job.promise;
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
    let cleared: any = { steering: [], followUp: [] };
    try {
      const response = await handle.send({ type: "clear_queue" }, { timeoutMs: 2000 }); cleared = response.data;
      if (close) await handle.stop();
      else {
        try {
          await handle.send({ type: "abort" }, { timeoutMs: this.options.stopOptions?.abortTimeoutMs ?? 10000 });
          // abort 的响应不能证明挂起的扩展命令已结束；抢占时关闭进程才能结束全部底层等待项。
          if (preempted) await handle.stop();
          else if (session.handle === handle && handle.acceptingInput) { session.model.control("idle", "idle"); await this.sync(session); }
        }
        catch { await handle.stop(); }
      }
    } catch { await handle.stop(); }
    const texts: string[] = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])];
    // 技能和提示模板在入队前已由 pi 展开，队列文字与发送时的编码文字不同；
    // 带图片的草稿按每条消息唯一的图片标记 nonce 对应，整条草稿（含图片节点）放回输入框。
    const keys = texts.map((text) => {
      if (session.drafts.has(text)) return text;
      const nonce = /⟦pane-img:([a-z0-9]{6,8}):\d+⟧/.exec(text)?.[1];
      return nonce ? [...session.drafts.keys()].find((key) => key.includes(`⟦pane-img:${nonce}:`)) : undefined;
    });
    const drafts = texts.map((text, i) => (keys[i] && session.drafts.get(keys[i]!)) || [{ type: "text", text }]);
    if (!session.handle || session.handle === handle) for (const key of keys) if (key) session.drafts.delete(key);
    return { status: "done", clearedText: texts, clearedDrafts: drafts };
  }
  private reclaim(): Promise<void> { return this.inflight.run("sessions.reclaim", () => this.performReclaim()); }
  private async performReclaim(): Promise<void> {
    for (const session of this.records.values()) if (session.handle && session.model.status === "idle" && !session.clients && !session.holds.size && !session.ui.size && Date.now() - session.lastActive >= (this.options.idleReclaimMs ?? 1800000)) await this.stop(session, true);
  }
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.performClose();
    return this.closePromise;
  }
  private async performClose(): Promise<void> {
    const ending = this.inflight.owner("sessions.close");
    this.inflight.seal(); this.closing = true; clearInterval(this.timer); this.trust.close(); const errors: unknown[] = [];
    const starts = [...this.starts];
    for (const [controller] of starts) controller.abort(new PaneError("interrupted", "会话已关闭", 409));
    const handles = new Set(this.handles.keys());
    for (const session of this.records.values()) {
      session.closed = true; this.closeUi(session); unwatchFile(session.file);
      if (session.handle) handles.add(session.handle);
    }
    // 停止本身也可能挂起；并行发出停止，任何 await 都必须落在限时屏障内。
    void ending.run("settle", async () => {
      const work = [...handles].map(async handle => { await handle.stop(); await handle.drain(); });
      // 单项拒绝立即保存，不能被另一项的永久等待挡在错误汇总之前。
      await Promise.allSettled([...work, ...starts.map(([, settled]) => settled), ...this.handles.values()]
        .map(operation => operation.catch(error => { errors.push(error); })));
    }).then(() => ending.close(), error => { errors.push(error); ending.close(); });
    // 超时保留真实登记与现场；失败后也必须让 PaneServer 进入 HTTP 收尾。
    try { await this.inflight.drain(this.closeTimeoutMs); } catch (error) { errors.push(error); }
    errors.push(...this.cleanupErrors);
    if (errors.length) throw new AggregateError(errors, "部分会话未确认停止");
  }
}
