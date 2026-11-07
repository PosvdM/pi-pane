import { randomUUID } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";
import { readFile, readdir, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { stopByIdentity, probeSessionWriterLock, type ProcessIdentity, type StopReport } from "pi-hostkit";
import type { ControlRequest, DraftNode, SessionStreamEvent, StreamCursor } from "@pi-pane/plugin-api";
import { AssetStore } from "./assets.js";
import { BridgeBroker } from "./bridge.js";
import { ControlQueue, RequestLedger } from "./control.js";
import { RpcSubprocessDriver, verifyStopped, type DriverHandle, type DriverOptions } from "./driver.js";
import { assert, PaneError } from "./errors.js";
import { SessionModel } from "./model.js";
import { fileKey, PiStore, readSession, type Entry } from "./store.js";
import { TrustDecisions } from "./trust.js";

interface HostedSession {
  id: string; file: string; cwd: string; model: SessionModel; control: ControlQueue; handle?: DriverHandle;
  state?: any; syncing?: Promise<void>; dirty: boolean; drafts: Map<string, DraftNode[]>; clients: number; lastActive: number;
  holds: Map<string, { source: string; reason: string }>; ui: Map<string, any>; recentExternal: boolean; closed: boolean;
}
const mutations = new Set(["prompt", "steer", "follow_up", "stop", "close", "restart", "set_model", "set_thinking_level", "compact", "new_session", "fork", "clone", "set_session_name"]);
const queries = new Set(["get_state", "get_available_models", "get_commands", "get_session_stats", "get_fork_messages", "get_last_assistant_text"]);
export interface SessionManagerOptions extends DriverOptions { idleReclaimMs?: number }
export class Sessions {
  readonly ledger = new RequestLedger();
  private records = new Map<string, HostedSession>(); private files = new Map<string, HostedSession>();
  private driver: RpcSubprocessDriver; private timer: ReturnType<typeof setInterval>; private projects = new Set<string>();
  private recovering = true; readonly reports: StopReport[] = [];
  constructor(readonly assets: AssetStore, readonly store: PiStore, readonly trust: TrustDecisions, broker: BridgeBroker, private readonly options: SessionManagerOptions,
    private readonly emitUi: (sessionId: string, request: any) => void) {
    this.driver = new RpcSubprocessDriver(broker, { ...options, onTrust: (cwd) => trust.request(cwd) });
    this.timer = setInterval(() => { void this.reclaim().catch(() => {}); }, 10000); this.timer.unref();
  }
  async recover(): Promise<void> {
    const directory = path.join(this.options.home, "run"); await mkdir(directory, { recursive: true });
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(path.join(directory, file), "utf8")) as { identity: ProcessIdentity; sessionFile: string };
      assert(record.identity && typeof record.sessionFile === "string", "invalidRunRecord", "运行记录损坏，不能重新打开会话", 503);
      // 在所有恢复完成前不接受会话打开；身份查询不明或 StopReport 不完整时保留现场。
      const report = await stopByIdentity(record.identity, this.options.stopOptions); await verifyStopped(record.identity, report); this.reports.push(report);
      await rm(path.join(directory, file));
    }
    this.recovering = false;
  }
  private record(id: string): HostedSession { const session = this.records.get(id); assert(session, "sessionMissing", "会话不存在", 404); return session; }
  async open(input: { cwd: string; sessionFile?: string; fork?: boolean }): Promise<any> {
    assert(!this.recovering, "recovering", "旧进程尚未完成恢复", 503);
    assert(typeof input.cwd === "string" && path.isAbsolute(input.cwd), "invalidCwd", "项目目录必须为绝对路径");
    const cwd = await import("node:fs/promises").then((fs) => fs.realpath(input.cwd));
    this.projects.add(cwd);
    const directory = await this.store.sessionDir(cwd); await mkdir(directory, { recursive: true });
    let file = input.sessionFile ?? path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
    assert(path.isAbsolute(file), "invalidSessionFile", "会话文件必须为绝对路径");
    if (input.fork) file = await this.store.fork(file, cwd, directory);
    const known = this.files.get(fileKey(file)); if (known) return this.view(known);
    const parsed = await readSession(file); const id = parsed.header?.id ?? randomUUID();
    assert(typeof id === "string" && !this.records.has(id), "sessionIdentityConflict", "另一个文件使用了相同的会话标识", 409);
    const model = new SessionModel({ source: "pane", id }, this.assets); model.reset(parsed.entries, parsed.leafId);
    const busy = await probeSessionWriterLock(file); model.readonlyReason = busy.held ? "externalWriter" : "archived";
    let recentExternal = false;
    try { recentExternal = !input.fork && Date.now() - (await stat(file)).mtimeMs < 60000; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const session: HostedSession = { id, file, cwd, model, control: new ControlQueue(), dirty: false, drafts: new Map(), clients: 0, lastActive: Date.now(), holds: new Map(), ui: new Map(), recentExternal, closed: false };
    this.records.set(id, session); this.files.set(fileKey(file), session);
    watchFile(file, { persistent: false, interval: 500 }, () => {
      if (session.handle || session.closed) return;
      void readSession(file).then((parsed) => { if (!session.handle && !session.closed) model.reset(parsed.entries, parsed.leafId); }).catch((error) => model.emit({ type: "pane_diagnostic", message: String(error) }));
    });
    return { ...this.view(session), diagnostics: parsed.diagnostics, ...(busy.held ? { heldBy: busy.record?.host.app } : {}), ...(recentExternal ? { warning: "recentModification" } : {}) };
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
    return this.ledger.execute(request.requestId, { sessionId: id, ...request }, () => this.record(id).control.run(async () => {
      const session = this.record(id); const model = session.model; const command = request.command;
      assert(command && mutations.has(command.type), "unsupportedCommand", "不支持此会话控制命令");
      assert(request.expectedEpoch === model.epoch, "epochChanged", "会话进程已更换，请重新读取快照", 409);
      assert(request.expectedRevision === model.controlRevision, "revisionChanged", "会话状态已变化，请重新确认", 409);
      session.lastActive = Date.now();
      if (command.type === "restart") { if (session.handle) await session.handle.stop(); session.recentExternal = false; await this.start(session); return { status: "accepted", snapshot: this.view(session) }; }
      if (command.type === "close") {
        assert(!session.holds.size || command.confirmHolds === true, "holdsConfirmation", "会话仍有保活原因，请确认关闭", 409);
        const result = await this.stop(session, true); session.holds.clear(); return result;
      }
      if (command.type === "stop") return this.stop(session, false);
      assert(model.inFlight.phase !== "stopping", "stopping", "正在停止，请稍后重试", 409);
      if (!session.handle) await this.start(session);
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
      model.control(["prompt", "steer", "follow_up", "compact"].includes(command.type) ? "running" : model.status,
        command.type === "compact" ? "compacting" : ["prompt", "steer", "follow_up"].includes(command.type) ? "streaming" : model.inFlight.phase, undefined, true);
      const response = await session.handle.send(rpc);
      await this.sync(session);
      if (["set_model", "set_thinking_level"].includes(command.type)) session.state = (await session.handle.send({ type: "get_state" })).data;
      return { status: "accepted", response, snapshot: this.view(session) };
    }));
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
  private async start(session: HostedSession): Promise<void> {
    assert(!session.recentExternal, "recentModification", "该会话可能正在别处运行，请只读查看或 Fork 为新会话", 409);
    await this.trust.request(session.cwd);
    try {
      session.handle = await this.driver.start({ cwd: session.cwd, sessionFile: session.file, sessionDir: await this.store.sessionDir(session.cwd), decisions: this.trust.config() }, {
        onRecord: (event) => this.receive(session, event),
        onReady: (state, data, reason) => this.rebind(session, state, data, reason),
        onExit: (reason, report, error) => {
          if (report) this.reports.push(report);
          session.handle = undefined; session.ui.clear(); session.model.interrupt("pi", `${reason}${error ? `：${String(error)}` : ""}`); session.lastActive = Date.now(); session.recentExternal = false;
        },
      });
      await session.handle.ready;
    } catch (error) {
      if (error instanceof PaneError && error.code === "externalWriter") session.model.readonlyReason = "externalWriter";
      throw error;
    }
  }
  private rebind(session: HostedSession, state: any, data: any, reason: string): void {
    const old = session.model; const changed = state.sessionId !== session.id || fileKey(state.sessionFile) !== fileKey(session.file);
    if (changed) {
      old.emit({ type: "pane_session_replaced", newRef: { source: "pane", id: state.sessionId }, reason });
      old.readonly = true; old.readonlyReason = "archived"; old.control("idle", "idle", undefined, true);
      const previous: HostedSession = { ...session, handle: undefined, drafts: new Map(), control: new ControlQueue(), holds: new Map(), ui: new Map(), recentExternal: false };
      this.records.set(session.id, previous); this.files.set(fileKey(session.file), previous);
      session.id = state.sessionId; session.file = state.sessionFile; session.model = new SessionModel({ source: "pane", id: state.sessionId }, this.assets);
      this.records.set(session.id, session); this.files.set(fileKey(session.file), session);
    }
    session.state = state; session.cwd = state.cwd ?? session.cwd; session.model.readonly = false; session.model.readonlyReason = undefined;
    session.model.reset(data.entries as Entry[], data.leafId); session.model.control("idle", "idle", undefined, true); session.recentExternal = false;
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
        session.dirty = false; const model = session.model; const epoch = model.epoch; const since = model.entries.at(-1)?.id;
        const response = await session.handle.send({ type: "get_entries", ...(since ? { since } : {}) });
        if (epoch !== model.epoch || session.model !== model) continue;
        const data = response.data as any; model.append(data.entries, data.leafId);
      }
    })().finally(() => { session.syncing = undefined; });
    return session.syncing;
  }
  private async stop(session: HostedSession, close: boolean): Promise<any> {
    if (!session.handle) return { status: "nothingToStop" };
    session.model.control("running", "stopping", undefined, true);
    let cleared: any = { steering: [], followUp: [] }; let report: StopReport | undefined;
    try {
      const response = await session.handle.send({ type: "clear_queue" }, { timeoutMs: 2000 }); cleared = response.data;
      if (close) report = await session.handle.stop();
      else {
        try { await session.handle.send({ type: "abort" }, { timeoutMs: this.options.stopOptions?.abortTimeoutMs ?? 10000 }); session.model.control("idle", "idle"); await this.sync(session); }
        catch { report = await session.handle.stop(); }
      }
    } catch (error) { if (session.handle) report = await session.handle.stop(); else throw error; }
    const texts: string[] = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])];
    const drafts = texts.map((text) => session.drafts.get(text) ?? [{ type: "text", text }]);
    for (const text of texts) session.drafts.delete(text);
    return { status: "done", clearedText: texts, clearedDrafts: drafts, ...(report ? { stopReport: report } : {}) };
  }
  private async reclaim(): Promise<void> {
    for (const session of this.records.values()) if (session.handle && session.model.status === "idle" && !session.clients && !session.holds.size && !session.ui.size && Date.now() - session.lastActive >= (this.options.idleReclaimMs ?? 1800000)) await this.stop(session, true);
  }
  async close(): Promise<void> {
    clearInterval(this.timer); this.trust.close(); const errors: unknown[] = [];
    for (const session of this.records.values()) {
      session.closed = true; unwatchFile(session.file);
      if (session.handle) try { await session.handle.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "部分会话未确认停止");
  }
}
