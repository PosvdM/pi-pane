// 打开的插件节点：会话节点按能力取快照（open）并订阅事件（subscribe），group 和 resource 节点只显示面板（plugin-api.md“会话视图”“面板”）。
import { api, ApiError, newId } from "./api.ts";
import { settleOp, trackOp } from "./plugin-ui.ts";
import { apply, fromSnapshot, prependHistory, type ModelState } from "./session-model.ts";
import { Store } from "./store.ts";
import { pinNode } from "./tree.ts";
import { confirmInApp, toast } from "./ui-state.ts";
import * as ws from "./ws.ts";
import type { AbortResult, PaneSessionView, SendResult, SessionRef, SessionSnapshot, TreeNode, UnfinishedPartial } from "./types.ts";

export interface PluginView {
  nodeId: string;
  source: string;
  ref?: SessionRef;
  model: ModelState | null;
  partials: UnfinishedPartial[];
  loading: boolean;
  /** 会话节点没有 open 能力：只显示面板和节点信息，不取快照。 */
  closed?: boolean;
  error?: string;
}
/** 当前打开的插件节点；为 null 时主区域显示主会话（session.ts 的 current）。 */
export const pluginView = new Store<PluginView | null>(null);

/**
 * 一次打开对应一个控制对象。所有异步请求在返回后核对它仍是当前打开的节点，
 * 旧节点的重载、重试、冲突后的重新确认都不会作用到之后打开的节点上。
 */
interface Opened {
  ref?: SessionRef;
  live: boolean;           // 是否订阅实时流（节点有 subscribe 能力）
  send: boolean;           // 节点有 send 能力；变化时快照中的 readonly 可能已过时
  unsubscribe: (() => void) | null;
  reloading: Promise<void> | null;
  retries: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}
let opened: Opened | null = null;
const isCurrent = (o: Opened) => opened === o;

const sessionPath = (ref: SessionRef, op: string) => `/api/plugins/${encodeURIComponent(ref.source)}/sessions/${encodeURIComponent(ref.id)}/${op}`;

/** 快照没有主会话的文件和目录字段，补成会话模型使用的形状；这些字段在插件会话视图中不显示。 */
function toView(snapshot: SessionSnapshot): PaneSessionView {
  return { ...snapshot, sessionFile: "", cwd: "", hosted: false, inFlight: snapshot.inFlight ?? { phase: "idle", tools: [], queue: { steering: [], followUp: [] } } } as unknown as PaneSessionView;
}

export function closePluginView(): void {
  const o = opened; opened = null;
  if (o) { o.unsubscribe?.(); clearTimeout(o.retryTimer); }
  pluginView.set(null);
}

export async function openPluginNode(node: TreeNode): Promise<void> {
  closePluginView();
  pinNode(node.source, node.id);
  const session = node.kind === "session" && !!node.sessionRef;
  const canOpen = session && node.capabilities.includes("open");
  const o: Opened = { ...(canOpen ? { ref: node.sessionRef } : {}), live: canOpen && node.capabilities.includes("subscribe"), send: node.capabilities.includes("send"), unsubscribe: null, reloading: null, retries: 0 };
  opened = o;
  pluginView.set({ nodeId: node.id, source: node.source, ...(canOpen ? { ref: node.sessionRef } : {}), model: null, partials: [], loading: canOpen, ...(session && !canOpen ? { closed: true } : {}) });
  if (canOpen) await refresh(o);
}

/**
 * 节点能力变化时调整：不再提供实时流（如任务结束）就取消订阅；开始提供实时流，或 send 能力有变化（如接管后
 * 开放输入），重取快照。插件可能只通过树节点改能力、不在会话流里推 pane_status，快照中的 readonly 随之更新。
 */
export function syncCapabilities(node: TreeNode): void {
  const o = opened; const view = pluginView.get();
  if (!o?.ref || view?.nodeId !== node.id) return;
  const live = node.capabilities.includes("subscribe");
  const send = node.capabilities.includes("send");
  const sendChanged = send !== o.send; o.send = send;
  if (live !== o.live) {
    o.live = live;
    if (!live) { o.unsubscribe?.(); o.unsubscribe = null; }
  } else if (!sendChanged) return;
  if (view.model && (live || sendChanged)) void reload(o);
}

function retry(o: Opened, error: unknown): void {
  pluginView.set((v) => v && { ...v, loading: false, error: `${(error as Error).message}（正在重试）` });
  const delay = Math.min(10000, 1000 * 2 ** o.retries++);
  clearTimeout(o.retryTimer); o.retryTimer = setTimeout(() => { if (isCurrent(o)) void refresh(o); }, delay);
}

/**
 * 取快照，再以快照的游标订阅或续订（节点有 subscribe 能力时）。
 * 取快照失败时（如插件的后台服务暂时离线）按退避间隔重试，直到成功或离开该节点；否则离线期间推来的 resync 无处送达。
 */
function refresh(o: Opened): Promise<void> {
  if (o.reloading) return o.reloading;
  const ref = o.ref!;
  const run = (async () => {
    let snapshot: SessionSnapshot;
    try { snapshot = await api<SessionSnapshot>(sessionPath(ref, "snapshot")); }
    catch (error) { if (isCurrent(o)) retry(o, error); return; }
    if (!isCurrent(o)) return;
    pluginView.set((v) => v && { ...v, model: fromSnapshot(toView(snapshot)), partials: snapshot.unfinishedPartials ?? [], loading: false, error: undefined });
    o.retries = 0;
    if (!o.live) return;
    if (o.unsubscribe) ws.resubscribe(ref);
    else o.unsubscribe = ws.subscribe(ref, () => pluginView.get()?.model?.view.cursor ?? { epoch: "", seq: 0 }, (record) => onEvent(o, record));
  })().finally(() => { o.reloading = null; });
  o.reloading = run;
  return run;
}

function onEvent(o: Opened, record: Parameters<typeof apply>[1]): void {
  const view = pluginView.get();
  // 重取快照期间到达的事件不应用：快照之后会按新游标续订，服务端从游标重放。
  if (!isCurrent(o) || !view?.model || o.reloading) return;
  const result = apply(view.model, record);
  if (result === "resync") { void reload(o); return; }
  if (result === "applied") pluginView.touch();
}

/** 游标断开、epoch 变化或收到 resync：重取快照，再以新游标续订。 */
function reload(o: Opened): Promise<void> {
  return isCurrent(o) && o.ref ? refresh(o) : Promise.resolve();
}

export async function loadOlder(): Promise<void> {
  const o = opened; const view = pluginView.get(); const before = view?.model?.view.historyBefore;
  if (!o || !view?.ref || !view.model || !before) return;
  try {
    const page = await api<{ entries: any[]; historyBefore: string | null }>(`${sessionPath(view.ref, "history")}?before=${encodeURIComponent(before)}&limit=50`);
    if (!isCurrent(o) || !pluginView.get()?.model) return;
    prependHistory(pluginView.get()!.model!, page.entries, page.historyBefore); pluginView.touch();
  } catch (error) { toast((error as Error).message, "error"); }
}

/**
 * 向插件会话发消息（节点有 send 能力、没有 composer 时）。
 * 返回 sent（已受理）、failed（确定没有执行，调用方把文字放回输入框）或 unknown（超时或断网，文字放回，并留下“查询结果”）。
 */
export async function sendToPlugin(text: string, delivery?: "steer" | "followUp"): Promise<"sent" | "failed" | "unknown"> {
  const o = opened; const view = pluginView.get(); if (!o || !view?.ref) return "failed";
  const ref = view.ref;
  const expectedRevision = view.model?.view.controlRevision;
  const body = { input: { text, ...(delivery ? { delivery } : {}) }, idempotencyKey: newId(), connectionId: ws.link.get().connectionId, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
  const attempt = async (): Promise<"sent" | "failed" | "unknown"> => {
    let result: SendResult;
    try { result = await api<SendResult>(sessionPath(ref, "send"), { ...body, connectionId: ws.link.get().connectionId }); }
    catch (error) {
      if (error instanceof ApiError && (error.code === "network" || error.code === "pluginTimeout" || error.status === 504)) {
        trackOp({ key: body.idempotencyKey, source: ref.source, state: "unknown", message: "消息的发送结果未知，文字已放回输入框",
          query: async () => { if (await attempt() === "sent") toast("消息已送达，请删去输入框里放回的文字"); } });
        return "unknown";
      }
      settleOp(body.idempotencyKey); toast((error as Error).message, "error"); return "failed";
    }
    settleOp(body.idempotencyKey);
    if (result.status === "accepted" || result.status === "pending") return "sent";
    if (result.status === "conflict") {
      await reload(o);
      if (isCurrent(o)) toast(result.message ?? "会话状态已变化，请确认后重新发送", "error");
      return "failed";
    }
    toast(result.message, "error"); return "failed";
  };
  return attempt();
}

/** 停止：清空队列后中止，清出的文本交给调用方放回输入框。冲突时重新读取状态并请用户确认，确认前已切换到其他节点则放弃。 */
export async function abortPlugin(): Promise<string[] | null> {
  const o = opened; if (!o?.ref) return null;
  return abortOpened(o);
}
async function abortOpened(o: Opened): Promise<string[] | null> {
  const ref = o.ref!;
  const expectedRevision = pluginView.get()?.model?.view.controlRevision;
  try {
    const result = await api<AbortResult>(sessionPath(ref, "abort"), { clearQueue: true, connectionId: ws.link.get().connectionId, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    if (result.status === "conflict") {
      await reload(o);
      if (!isCurrent(o) || !(await confirmInApp("会话状态已变化，仍要停止吗？", true)) || !isCurrent(o)) return null;
      return abortOpened(o);
    }
    if (result.status === "nothingToStop") toast("没有正在运行的任务");
    return result.status === "done" ? result.clearedText ?? [] : null;
  } catch (error) { toast((error as Error).message, "error"); return null; }
}
