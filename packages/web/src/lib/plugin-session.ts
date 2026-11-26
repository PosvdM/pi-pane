// 打开的插件节点：会话节点按能力取快照（open）并订阅事件（subscribe），group 和 resource 节点只显示面板（plugin-api.md“会话视图”“面板”）。
import { api, newId } from "./api.ts";
import type { OpState, OpStep, OpText } from "./operation.ts";
import { newOperation, pluginRequestSignal, requestFailed } from "./plugin-ui.ts";
import { apply, fromSnapshot, keepLoadedHistory, prependHistory, type ModelState } from "./session-model.ts";
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
  /** 会话节点的引用；停止（abort）不依赖 open 能力，没有 open 时也保留。 */
  ref?: SessionRef;
  open: boolean;           // 是否取快照（节点有 open 能力）
  live: boolean;           // 是否新建实时订阅（节点同时有 open 和 subscribe 能力）；已建立的订阅不随它撤销
  send: boolean;           // 节点有 send 能力；变化时快照中的 readonly 可能已过时
  unsubscribe: (() => void) | null;
  reloading: Promise<void> | null;
  again?: boolean;         // 取快照期间又有重取请求
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
  const o: Opened = { ...(session ? { ref: node.sessionRef } : {}), open: canOpen, live: canOpen && node.capabilities.includes("subscribe"), send: node.capabilities.includes("send"), unsubscribe: null, reloading: null, retries: 0 };
  opened = o;
  pluginView.set({ nodeId: node.id, source: node.source, ...(canOpen ? { ref: node.sessionRef } : {}), model: null, partials: [], loading: canOpen, ...(session && !canOpen ? { closed: true } : {}) });
  if (canOpen) await refresh(o);
}

/**
 * 节点能力变化时调整已打开的视图（plugin-api.md 的能力表）：
 * - 撤销 open：取消订阅、丢掉已显示的内容，改为只显示节点信息和面板；补上 open：取快照，有 subscribe 时订阅。
 * - 撤销 subscribe 只影响以后是否新建订阅，已建立的订阅保持到用户离开该节点（plugin-api.md“显示规则”）：插件常在会话结束时
 *   撤销 subscribe，最终状态和最后几条输出可能晚于树更新到达，仍经这条订阅送来；之后的 resync 照常按新游标续订这条订阅。
 *   补回 subscribe 时还没有订阅（打开时节点就没有 subscribe）才从当前游标订阅，不重取快照。
 * - send 能力有变化（如接管后开放输入）时重取快照：插件可能只通过树节点改能力、不在会话流里推 pane_status，
 *   快照中的 readonly 随之更新。
 */
export function syncCapabilities(node: TreeNode): void {
  const o = opened; const view = pluginView.get();
  if (!o?.ref || view?.nodeId !== node.id) return;
  const open = node.capabilities.includes("open");
  const live = open && node.capabilities.includes("subscribe");
  const send = node.capabilities.includes("send");
  const sendChanged = send !== o.send; o.send = send;
  if (open !== o.open) {
    o.open = open; o.live = live; o.unsubscribe?.(); o.unsubscribe = null; clearTimeout(o.retryTimer); o.retries = 0;
    if (!open) { pluginView.set((v) => v && { nodeId: v.nodeId, source: v.source, model: null, partials: [], loading: false, closed: true }); return; }
    const ref = o.ref;
    pluginView.set((v) => v && { nodeId: v.nodeId, source: v.source, ref, model: null, partials: [], loading: true });
    void refresh(o);
    return;
  }
  if (!open) return;
  if (live !== o.live) {
    o.live = live;
    // 补上时还没有订阅就从当前游标订阅，插件按游标重放其间的事件，接不上时推 resync（plugin-api.md“事件流”）。
    if (live && !o.unsubscribe) {
      if (o.reloading) o.again = true;  // 取快照在途：可能已越过订阅的判断，完成后再取一次并订阅
      else if (pluginView.get()?.model) subscribeLive(o);
    }
  }
  if (!sendChanged) return;
  // send 变化时快照中的 readonly 可能已过时，重取。首次快照还没返回时也要重取：在途的快照可能早于这次能力变化（refresh 完成后再取一次）。
  void reload(o);
}

function subscribeLive(o: Opened): void {
  o.unsubscribe = ws.subscribe(o.ref!, () => pluginView.get()?.model?.view.cursor ?? { epoch: "", seq: 0 }, (record) => onEvent(o, record));
}

function retry(o: Opened, error: unknown): void {
  pluginView.set((v) => v && { ...v, loading: false, error: `${(error as Error).message}（正在重试）` });
  const delay = Math.min(10000, 1000 * 2 ** o.retries++);
  clearTimeout(o.retryTimer); o.retryTimer = setTimeout(() => { if (isCurrent(o) && o.open) void refresh(o); }, delay);
}

/**
 * 取快照，再以快照的游标订阅或续订（节点有 subscribe 能力时）。
 * 取快照失败时（如插件的后台服务暂时离线）按退避间隔重试，直到成功或离开该节点；否则离线期间推来的 resync 无处送达。
 * 取快照期间又有重取请求（如节点能力在此期间再次变化）时，这一次的快照可能早于该变化，完成后再取一次。
 */
function refresh(o: Opened): Promise<void> {
  if (o.reloading) { o.again = true; return o.reloading; }
  const ref = o.ref!;
  const run = (async () => {
    do {
      o.again = false;
      let snapshot: SessionSnapshot;
      try { snapshot = await api<SessionSnapshot>(sessionPath(ref, "snapshot")); }
      catch (error) { o.again = false; if (isCurrent(o) && o.open) retry(o, error); return; }
      if (!isCurrent(o) || !o.open) return;
      pluginView.set((v) => {
        if (!v) return v;
        const model = fromSnapshot(toView(snapshot));
        if (v.model) keepLoadedHistory(model, v.model);
        return { ...v, model, partials: snapshot.unfinishedPartials ?? [], loading: false, error: undefined };
      });
      o.retries = 0;
    } while (o.again);
    // 已建立的订阅（含撤销 subscribe 之后保留的）按新游标续订；没有订阅时只在节点有 subscribe 能力时新建。
    if (o.unsubscribe) ws.resubscribe(ref);
    else if (o.live) subscribeLive(o);
  })().finally(() => {
    // 循环结束到这里之间（含订阅阶段）到达的重取请求只设了标记，在这里补取。
    o.reloading = null;
    if (o.again && isCurrent(o) && o.open) void refresh(o);
  });
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
  return isCurrent(o) && o.ref && o.open ? refresh(o) : Promise.resolve();
}

/**
 * 加载更早的消息。请求记下发起时的会话模型：每次取快照都换一个新模型，其间重取过快照（如分支切换后的 resync）时，
 * 迟到的历史页属于旧分支，丢弃。
 */
export async function loadOlder(): Promise<void> {
  const o = opened; const view = pluginView.get(); const model = view?.model; const before = model?.view.historyBefore;
  if (!o || !view?.ref || !model || !before) return;
  try {
    const page = await api<{ entries: any[]; historyBefore: string | null }>(`${sessionPath(view.ref, "history")}?before=${encodeURIComponent(before)}&limit=50`);
    if (!isCurrent(o) || pluginView.get()?.model !== model) return;
    prependHistory(model, page.entries, page.historyBefore); pluginView.touch();
  } catch (error) { toast((error as Error).message, "error"); }
}

/**
 * 向插件会话发消息（节点有 send 能力、没有 composer 时）。每次发送是一个操作对象（operation.ts）：首次响应和之后每次
 * “查询结果”都由它结算，查询沿用同一个幂等键和同样的内容（plugin-api.md“幂等规则”）。只有 accepted 确定送达；
 * 其余结果（rejected、conflict、idempotencyConflict、请求被拒、pending 含服务端等待超时、断网、浏览器超时）都在首次响应时把原文放回，
 * pending 和结果未知留下查询入口。查询请求本身失败（断网、超时、403 等）只说明这次查询没有成功。
 * text 为提交时移出输入框、已登记为在途提交的原文。
 */
export function sendToPlugin(value: string, delivery: "steer" | "followUp" | undefined, text: OpText): Promise<OpState> {
  const o = opened; const view = pluginView.get();
  const ref = o?.ref && view?.ref ? view.ref : undefined;
  const expectedRevision = view?.model?.view.controlRevision;
  const body = { input: { text: value, ...(delivery ? { delivery } : {}) }, idempotencyKey: newId(), ...(expectedRevision === undefined ? {} : { expectedRevision }) };
  const attempt = async (query: boolean): Promise<OpStep> => {
    if (!o || !ref) return { state: "notRun" };
    let result: SendResult;
    try { result = await api<SendResult>(sessionPath(ref, "send"), { ...body, connectionId: ws.link.get().connectionId }, pluginRequestSignal()); }
    catch (error) { return requestFailed(error, query); }
    switch (result.status) {
      case "accepted": return { state: "done" };
      case "pending": return { state: "pending", ...((result as { message?: string }).message ? { message: (result as { message?: string }).message } : {}) };
      case "conflict":
        // 先结算（原文立即放回），再重取快照，用户按最新状态决定是否重发；不等快照返回。
        void reload(o);
        return { state: "notRun", ...(isCurrent(o) ? { message: result.message ?? "会话状态已变化，请确认后重新发送" } : {}) };
      default: return { state: "notRun", message: result.message };
    }
  };
  return newOperation({ key: body.idempotencyKey, source: ref?.source ?? view?.source ?? "", attempt, pendingText: "消息已提交，插件仍在处理", unknownText: "消息的发送结果未知", text }).run();
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
