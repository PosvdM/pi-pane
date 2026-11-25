// 打开的插件节点：会话节点取快照并订阅事件，group 和 resource 节点只显示面板（plugin-api.md“会话视图”“面板”）。
import { api, ApiError, newId } from "./api.ts";
import { apply, fromSnapshot, prependHistory, type ModelState } from "./session-model.ts";
import { Store } from "./store.ts";
import { pinNode } from "./tree.ts";
import { toast } from "./ui-state.ts";
import * as ws from "./ws.ts";
import type { AbortResult, PaneSessionView, SendResult, SessionRef, SessionSnapshot, TreeNode, UnfinishedPartial } from "./types.ts";

export interface PluginView {
  nodeId: string;
  source: string;
  ref?: SessionRef;
  model: ModelState | null;
  partials: UnfinishedPartial[];
  loading: boolean;
  error?: string;
}
/** 当前打开的插件节点；为 null 时主区域显示主会话（session.ts 的 current）。 */
export const pluginView = new Store<PluginView | null>(null);

let unsubscribe: (() => void) | null = null;
let nav = 0;
let reloading: Promise<void> | null = null;

const sessionPath = (ref: SessionRef, op: string) => `/api/plugins/${encodeURIComponent(ref.source)}/sessions/${encodeURIComponent(ref.id)}/${op}`;

/** 快照没有主会话的文件和目录字段，补成会话模型使用的形状；这些字段在插件会话视图中不显示。 */
function toView(snapshot: SessionSnapshot): PaneSessionView {
  return { ...snapshot, sessionFile: "", cwd: "", hosted: false, inFlight: snapshot.inFlight ?? { phase: "idle", tools: [], queue: { steering: [], followUp: [] } } } as unknown as PaneSessionView;
}

export function closePluginView(): void {
  nav++; unsubscribe?.(); unsubscribe = null; pluginView.set(null);
}

export async function openPluginNode(node: TreeNode): Promise<void> {
  closePluginView();
  const mine = nav;
  pinNode(node.source, node.id);
  pluginView.set({ nodeId: node.id, source: node.source, ...(node.sessionRef ? { ref: node.sessionRef } : {}), model: null, partials: [], loading: !!node.sessionRef });
  if (node.sessionRef) await loadSnapshot(node.sessionRef, mine);
}

async function loadSnapshot(ref: SessionRef, mine: number): Promise<void> {
  try {
    const snapshot = await api<SessionSnapshot>(sessionPath(ref, "snapshot"));
    if (mine !== nav) return;
    pluginView.set((v) => v && { ...v, model: fromSnapshot(toView(snapshot)), partials: snapshot.unfinishedPartials ?? [], loading: false, error: undefined });
    unsubscribe?.();
    unsubscribe = ws.subscribe(ref, () => pluginView.get()?.model?.view.cursor ?? { epoch: "", seq: 0 }, (record) => onEvent(mine, record));
  } catch (error) {
    if (mine === nav) pluginView.set((v) => v && { ...v, loading: false, error: (error as Error).message });
  }
}

function onEvent(mine: number, record: Parameters<typeof apply>[1]): void {
  const view = pluginView.get();
  if (mine !== nav || !view?.model || reloading) return;
  const result = apply(view.model, record);
  if (result === "resync") { void reload(); return; }
  if (result === "applied") pluginView.touch();
}

/** 游标断开或 epoch 变化：重取快照，再以新游标续订。 */
export function reload(): Promise<void> {
  const view = pluginView.get(); if (!view?.ref) return Promise.resolve();
  if (reloading) return reloading;
  const mine = nav; const ref = view.ref;
  reloading = (async () => {
    try {
      const snapshot = await api<SessionSnapshot>(sessionPath(ref, "snapshot"));
      if (mine !== nav) return;
      pluginView.set((v) => v && { ...v, model: fromSnapshot(toView(snapshot)), partials: snapshot.unfinishedPartials ?? [], error: undefined });
    } catch (error) { if (mine === nav) pluginView.set((v) => v && { ...v, error: (error as Error).message }); }
    finally { reloading = null; }
    if (mine === nav) ws.resubscribe(ref);
  })();
  return reloading;
}

export async function loadOlder(): Promise<void> {
  const view = pluginView.get(); const before = view?.model?.view.historyBefore;
  if (!view?.ref || !view.model || !before) return;
  const mine = nav;
  try {
    const page = await api<{ entries: any[]; historyBefore: string | null }>(`${sessionPath(view.ref, "history")}?before=${encodeURIComponent(before)}&limit=50`);
    if (mine !== nav || !pluginView.get()?.model) return;
    prependHistory(pluginView.get()!.model!, page.entries, page.historyBefore); pluginView.touch();
  } catch (error) { toast((error as Error).message, "error"); }
}

/** 向插件会话发消息（节点有 send 能力、没有 composer 时）。返回 false 表示需要保留输入框内容。 */
export async function sendToPlugin(text: string, delivery?: "steer" | "followUp"): Promise<boolean> {
  const view = pluginView.get(); if (!view?.ref) return false;
  const expectedRevision = view.model?.view.controlRevision;
  const body = { input: { text, ...(delivery ? { delivery } : {}) }, idempotencyKey: newId(), connectionId: ws.link.get().connectionId, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
  let result: SendResult;
  try { result = await api<SendResult>(sessionPath(view.ref, "send"), body); }
  catch (error) {
    if (error instanceof ApiError && (error.code === "network" || error.code === "pluginTimeout")) { toast("发送结果未知，请稍后查看会话", "error"); return true; }
    toast((error as Error).message, "error"); return false;
  }
  if (result.status === "accepted" || result.status === "pending") return true;
  if (result.status === "conflict") { await reload(); toast(result.message ?? "会话状态已变化，请确认后重新发送", "error"); return false; }
  toast(result.message, "error"); return false;
}

/** 停止：清空队列后中止，清出的文本交给调用方放回输入框。 */
export async function abortPlugin(): Promise<string[] | null> {
  const view = pluginView.get(); if (!view?.ref) return null;
  const expectedRevision = view.model?.view.controlRevision;
  try {
    const result = await api<AbortResult>(sessionPath(view.ref, "abort"), { clearQueue: true, connectionId: ws.link.get().connectionId, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    if (result.status === "conflict") { await reload(); if (confirm("会话状态已变化，仍要停止吗？")) return abortPlugin(); return null; }
    if (result.status === "nothingToStop") toast("没有正在运行的任务");
    return result.status === "done" ? result.clearedText ?? [] : null;
  } catch (error) { toast((error as Error).message, "error"); return null; }
}
