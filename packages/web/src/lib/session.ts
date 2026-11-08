// 当前打开的会话：取快照、订阅事件、发送控制命令、处理冲突与会话替换。
import { api, ApiError, newId } from "./api.ts";
import { apply, fromSnapshot, prependHistory, type Entry, type ModelState } from "./session-model.ts";
import { Store } from "./store.ts";
import { ask, emptyUi, extensionUi, toast } from "./ui-state.ts";
import * as ws from "./ws.ts";
import type {
  DraftNode, PaneCommand, PaneControlCommand, PaneControlResult, PaneOpenResult, PaneQueryResults, PaneQueryType,
  PaneSessionList, PaneSessionListItem, PaneSessionStats, PaneSessionView,
} from "./types.ts";

export interface Current {
  id: string;
  model: ModelState | null;
  loading: boolean;
  error?: string;
  warning?: "recentModification";
  heldBy?: string;
  stats?: PaneSessionStats;
  commands?: PaneCommand[];
}
export const current = new Store<Current | null>(null);
export const sessionList = new Store<{ items: PaneSessionListItem[]; loading: boolean; error?: string }>({ items: [], loading: false });

/** 停止或冲突后需要放回输入框的草稿；输入框订阅后取走。 */
export const restoredDrafts = new Store<{ sessionId: string; drafts: DraftNode[][] } | null>(null);
/** 扩展用 set_editor_text 设置的输入框文字。 */
export const editorText = new Store<{ sessionId: string; text: string; seq: number } | null>(null);

let unsubscribe: (() => void) | null = null;
/** 正在重取快照的会话与导航代次；只屏蔽同一会话、同一次导航的事件。 */
let reloading: { id: string; nav: number; promise: Promise<void> } | null = null;
/** 导航代次：每次打开会话加 1，只有最后一次导航的响应能写入当前会话。 */
let nav = 0;
const retiredEpochs = new Set<string>();
/** 本标签页发起了会切换会话的操作（首次发送、/new、/fork、/clone）：截止时间前收到替换事件时自动跟随。 */
let followUntil = 0;
const FOLLOW_WINDOW_MS = 15000;
/** 控制请求遇到网络错误时，用同一 requestId 重试的最长时间。 */
const NETWORK_RETRY_MS = 120000;

const LAST_SESSION_KEY = "pi-pane.lastSession";

export async function refreshList(): Promise<void> {
  sessionList.set((s) => ({ ...s, loading: true, error: undefined }));
  try {
    const { sessions } = await api<PaneSessionList>("/api/sessions");
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    sessionList.set({ items: sessions, loading: false });
  } catch (error) {
    sessionList.set((s) => ({ ...s, loading: false, error: (error as Error).message }));
  }
}

let listTimer: ReturnType<typeof setTimeout> | undefined;
/** 会话文件在首次回复后才落盘，运行结束或会话替换后刷新侧栏列表。 */
function scheduleListRefresh(): void {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => { void refreshList(); }, 500);
}

function setModel(id: string, view: PaneSessionView, extra: Partial<Current> = {}): void {
  const previous = current.get();
  const keep = previous?.id === id ? { stats: previous.stats, commands: previous.commands, warning: previous.warning, heldBy: previous.heldBy } : {};
  const model = fromSnapshot(view);
  current.set({ id, model, loading: false, ...keep, ...extra });
}

function attach(id: string): void {
  unsubscribe?.();
  unsubscribe = ws.subscribe(id, () => current.get()?.model?.view.cursor ?? { epoch: "", seq: 0 }, (record) => onEvent(id, record));
  sessionStorage.setItem(LAST_SESSION_KEY, id);
}

let stateTimer: ReturnType<typeof setTimeout> | undefined;
/** 名称、模型、思考级别可能由其他标签页或扩展改变：控制 revision 变化或会话信息变化后重新读取状态。 */
function scheduleStateRefresh(): void {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { void refreshState(); }, 200);
}

function onEvent(id: string, record: Parameters<typeof apply>[1]): void {
  const state = current.get();
  if (!state || state.id !== id || !state.model || (reloading?.id === id && reloading.nav === nav)) return;
  const revision = state.model.view.controlRevision;
  if (retiredEpochs.has(record.cursor.epoch)) return;
  const result = apply(state.model, record);
  if (result === "resync") { void reload(); return; }
  if (result !== "applied") return;
  const event = record.event as any;
  if (event.type === "pane_session_replaced") {
    if (Date.now() < followUntil) { followUntil = 0; void open(event.newRef.id); return; }
  }
  if (event.type === "pane_status" && event.status === "idle") { void refreshStats(); scheduleListRefresh(); }
  if (event.type === "pane_session_replaced") scheduleListRefresh();
  if (state.model.view.hosted && (state.model.view.controlRevision !== revision || ["session_info_changed", "model_select", "thinking_level_select", "model_changed", "thinking_level_changed"].includes(event.type))) scheduleStateRefresh();
  current.touch();
}

/** 重新取快照并以新游标续订。 */
export function reload(): Promise<void> {
  const state = current.get(); if (!state) return Promise.resolve();
  if (reloading && reloading.id === state.id && reloading.nav === nav) return reloading.promise;
  const id = state.id; const epoch = state.model?.view.cursor.epoch; const mine = nav;
  const promise = (async () => {
    try {
      const view = await api<PaneSessionView>(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
      if (current.get()?.id !== id || nav !== mine) return;
      if (epoch && epoch !== view.cursor.epoch) retiredEpochs.add(epoch);
      const replaced = current.get()?.model?.replaced;
      setModel(id, view);
      if (replaced && current.get()?.model) current.get()!.model!.replaced = replaced;
    } catch (error) {
      if (current.get()?.id === id && nav === mine) current.set((s) => s && { ...s, error: (error as Error).message });
    } finally { if (reloading?.id === id && reloading.nav === mine) reloading = null; }
    // 导航已经换了会话时，新会话的订阅不受这次重取影响。
    if (current.get()?.id !== id || nav !== mine) return;
    ws.resubscribe(id);
    current.touch();
  })();
  reloading = { id, nav: mine, promise };
  return promise;
}

/** 打开已登记的会话（按会话 id）。 */
export async function open(id: string): Promise<void> {
  const mine = ++nav;
  current.set({ id, model: null, loading: true });
  try {
    const view = await api<PaneSessionView>(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
    if (nav !== mine) return;
    setModel(id, view);
    attach(id);
    void refreshAuxiliary();
  } catch (error) {
    if (nav !== mine) return;
    if (error instanceof ApiError && error.status === 404) {
      // 服务端重启后会话登记丢失，需要从会话列表重新打开。
      sessionStorage.removeItem(LAST_SESSION_KEY);
      current.set(null);
      return;
    }
    current.set({ id, model: null, loading: false, error: (error as Error).message });
  }
}

/** 退出主界面（重新配对等）时取消订阅并清空当前会话。 */
export function detach(): void {
  nav++;
  unsubscribe?.(); unsubscribe = null;
  current.set(null);
}

/** 从会话列表打开，或在项目目录下新建（sessionFile 省略）。 */
export async function openFile(cwd: string, sessionFile?: string, fork = false): Promise<void> {
  const mine = ++nav;
  current.set({ id: "", model: null, loading: true });
  try {
    const result = await api<PaneOpenResult>("/api/sessions/open", { requestId: newId(), cwd, ...(sessionFile ? { sessionFile } : {}), ...(fork ? { fork: true } : {}) });
    if (nav !== mine) return;
    const id = result.ref.id;
    setModel(id, result, { warning: result.warning, heldBy: result.heldBy });
    attach(id);
    void refreshAuxiliary();
    void refreshList();
  } catch (error) {
    if (nav === mine) current.set({ id: "", model: null, loading: false, error: (error as Error).message });
  }
}

export function lastSessionId(): string | null { return sessionStorage.getItem(LAST_SESSION_KEY); }

export async function loadOlder(): Promise<void> {
  const state = current.get(); const model = state?.model; const before = model?.view.historyBefore;
  if (!state || !model || !before) return;
  try {
    const page = await api<{ entries: Entry[]; historyBefore: string | null }>(`/api/sessions/${encodeURIComponent(state.id)}/history?before=${encodeURIComponent(before)}&limit=50`);
    if (current.get()?.model !== model) return;
    prependHistory(model, page.entries, page.historyBefore);
    current.touch();
  } catch (error) {
    if (error instanceof ApiError && error.code === "historyChanged") void reload();
    else toast((error as Error).message, "error");
  }
}

export async function query<T extends PaneQueryType>(type: T): Promise<PaneQueryResults[T] | null> {
  const state = current.get(); if (!state?.model?.view.hosted) return null;
  return api<PaneQueryResults[T]>(`/api/sessions/${encodeURIComponent(state.id)}/query`, { type });
}

async function refreshStats(): Promise<void> {
  const id = current.get()?.id;
  try { const stats = await query("stats"); if (stats && current.get()?.id === id) current.set((s) => s && { ...s, stats }); }
  catch { /* 统计只用于显示，读取失败不影响会话。 */ }
}
async function refreshAuxiliary(): Promise<void> {
  const id = current.get()?.id;
  void refreshStats();
  try {
    const result = await query("commands");
    if (result && current.get()?.id === id) current.set((s) => s && { ...s, commands: result.commands });
  } catch { /* 补全列表取不到时只提供内置命令。 */ }
  await refreshState();
}
async function refreshState(): Promise<void> {
  const id = current.get()?.id; const model = current.get()?.model; const epoch = model?.view.cursor.epoch;
  try {
    const state = await query("state");
    if (state && model && current.get()?.id === id && current.get()?.model === model && model.view.cursor.epoch === epoch) { model.view.state = state; current.touch(); }
  } catch { /* 状态在下一次快照时更新。 */ }
}

export type ControlOutcome = { ok: true; result: PaneControlResult } | { ok: false; error: ApiError };

/** 发送一条控制命令。等待到期返回 pending 时，用同一 requestId 和同一内容重复提交，直到得到最终结果。 */
export async function control(command: PaneControlCommand, draft?: DraftNode[]): Promise<ControlOutcome> {
  const state = current.get(); const model = state?.model;
  if (!state || !model) return { ok: false, error: new ApiError(0, "noSession", "没有打开的会话") };
  const id = state.id;
  const body = { requestId: newId(), expectedEpoch: model.view.cursor.epoch, expectedRevision: model.view.controlRevision ?? 0, command, ...(draft ? { draft } : {}) };
  const switching = ["new_session", "fork", "clone"].includes(command.type) || (!model.view.hosted && ["prompt", "steer", "follow_up"].includes(command.type));
  if (switching) followUntil = Number.MAX_SAFE_INTEGER;
  const giveUp = Date.now() + NETWORK_RETRY_MS; let warned = false; let delay = 500;
  try {
    for (;;) {
      let result: PaneControlResult;
      try { result = await api<PaneControlResult>(`/api/sessions/${encodeURIComponent(id)}/control`, body); }
      catch (error) {
        // 响应丢失时服务端可能已经执行：用同一 requestId 和同一内容重试，由服务端去重并返回原结果。
        if (!(error instanceof ApiError && error.code === "network") || Date.now() > giveUp) throw error;
        if (!warned) { warned = true; toast("网络中断，恢复后自动核对这次操作的结果", "warning"); }
        await new Promise((r) => setTimeout(r, delay)); delay = Math.min(5000, delay * 2);
        continue;
      }
      if (result.status === "pending") { await new Promise((r) => setTimeout(r, 1000)); continue; }
      if (result.status === "accepted") {
        const next = result.snapshot.ref.id;
        if (next !== id && current.get()?.id === id) { followUntil = 0; await open(next); }
        else if (current.get()?.id === id && current.get()?.model) {
          const live = current.get()!.model!;
          // 响应中的快照可能落后于已收到的事件；只取更新的 revision 和托管状态。
          if ((result.snapshot.controlRevision ?? 0) > (live.view.controlRevision ?? 0) && result.snapshot.cursor.epoch === live.view.cursor.epoch) live.view.controlRevision = result.snapshot.controlRevision;
          if (result.snapshot.hosted && !live.view.hosted) { live.view.hosted = true; live.view.readonly = result.snapshot.readonly; live.view.readonlyReason = result.snapshot.readonlyReason; void refreshAuxiliary(); }
          if (result.snapshot.state) live.view.state = result.snapshot.state;
          current.touch();
        }
      }
      return { ok: true, result };
    }
  } catch (error) {
    let failure = error instanceof ApiError ? error : new ApiError(0, "unknown", String(error));
    if (failure.code === "network") failure = new ApiError(0, "network", "网络中断，这次操作可能已经执行。请在连接恢复后查看会话，再决定是否重发");
    if (failure.code === "epochChanged") { await reload(); }
    else if (failure.code === "revisionChanged") { await reload(); }
    else if (failure.code === "rpcResultUnknown") { await reload(); }
    return { ok: false, error: failure };
  } finally {
    // 进程内切换的重绑定可能晚于控制响应：响应后仍在一段时间内自动跟随替换事件。
    if (switching && followUntil) followUntil = Date.now() + FOLLOW_WINDOW_MS;
  }
}

/** 停止：clear_queue + abort，清出的消息回到输入框。 */
export async function stopRun(): Promise<void> {
  const state = current.get(); if (!state?.model) return;
  const outcome = await control({ type: "stop" });
  if (!outcome.ok) {
    if (outcome.error.code === "revisionChanged") {
      const phase = current.get()?.model?.view.inFlight?.phase;
      toast(phase === "idle" ? "这次运行已经结束" : phase === "stopping" ? "正在停止" : "会话状态已变化，请再次确认是否停止", "warning");
    } else toast(outcome.error.message, "error");
    return;
  }
  if (outcome.result.status === "done" && outcome.result.clearedDrafts.length) {
    restoredDrafts.set({ sessionId: state.id, drafts: outcome.result.clearedDrafts });
  }
}

export async function restart(): Promise<void> {
  let outcome = await control({ type: "restart" });
  if (!outcome.ok && /assumeNoWriter|状态不明|writerUnknown/.test(outcome.error.code + outcome.error.message)) {
    const answer = await ask("确认重启", "上一个写者的状态无法确认。请确认没有其他程序在写这个会话后再重启。", [{ label: "取消", value: "cancel" }, { label: "确认重启", value: "ok", danger: true }]);
    if (answer === "ok") outcome = await control({ type: "restart", assumeNoWriter: true });
  }
  if (!outcome.ok) toast(outcome.error.message, "error");
}

export async function closeSession(): Promise<void> {
  const state = current.get(); if (!state?.model) return;
  let outcome = await control({ type: "close" });
  if (!outcome.ok && outcome.error.code === "holdsConfirmation") {
    const holds = current.get()?.model?.view.holds.map((h) => `· ${h.reason}（${h.source}）`).join("\n") ?? "";
    const answer = await ask("关闭会话", `会话仍被保活：\n${holds}\n仍要关闭吗？`, [{ label: "取消", value: "cancel" }, { label: "关闭", value: "ok", danger: true }]);
    if (answer !== "ok") return;
    outcome = await control({ type: "close", confirmHolds: true });
  }
  if (!outcome.ok) { toast(outcome.error.message, "error"); return; }
  if (outcome.result.status === "done" && outcome.result.clearedDrafts.length) restoredDrafts.set({ sessionId: state.id, drafts: outcome.result.clearedDrafts });
  toast("会话已关闭");
}

/** 扩展 UI 状态的归属会话变化时清理。 */
export function uiFor(id: string) { return extensionUi.get()[id] ?? emptyUi(); }
