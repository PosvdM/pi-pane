// 侧栏会话树：pi-pane 自己的主会话树（source = "pane"）与各插件的树合并显示。
// 每个来源先取热节点快照，再从快照游标订阅变更；冷节点在用户展开“历史”时分页加载（plugin-api.md“按需加载”“同步”）。
import { api, ApiError } from "./api.ts";
import { activeSources } from "./plugins.ts";
import { Store } from "./store.ts";
import { findIn, isHot, RECENT_MS, SourceTree, TreePins } from "./tree-state.ts";
import type { TreeChange, TreeChildrenPage, TreeNode, TreeSnapshot } from "./types.ts";
import { toast } from "./ui-state.ts";
import * as ws from "./ws.ts";

export interface TreeStatus { loading: boolean; error?: string }
/** 各来源的树；对象本身原地修改，变化后 touch。 */
export const trees = new Store<Map<string, SourceTree>>(new Map());
export const treeStatus = new Store<Record<string, TreeStatus>>({});

const pinned = new Map<string, TreePins>();
const generation = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const unsubscribers = new Map<string, () => void>();
const retries = new Map<string, number>();
/** 为补取父节点而重取快照的来源及其父节点；快照到达前这些父节点下的节点不归入“未归属”。 */
const awaiting = new Map<string, Set<string>>();
let recentSince = Date.now() - RECENT_MS;

function tree(source: string): SourceTree {
  let value = trees.get().get(source);
  if (!value) { value = new SourceTree(source); trees.get().set(source, value); }
  return value;
}
function pins(source: string): TreePins {
  let value = pinned.get(source); if (!value) { value = new TreePins(); pinned.set(source, value); } return value;
}
/** 浏览器打开的节点和为补取父节点请求的节点；isHot 用它判断“打开着的”节点。 */
const pinnedIds = (source: string): ReadonlySet<string> => new Set(pins(source).request());
const base = (source: string) => source === "pane" ? "/api/tree" : `/api/plugins/${encodeURIComponent(source)}/tree`;
const hot = (source: string) => (node: TreeNode) => isHot(node, recentSince, pinnedIds(source));

/**
 * 取快照并从它的游标订阅。并发调用时只有最后一次能提交。
 * 失败时（如插件的后台服务正在重启）按退避间隔重试，直到成功、来源被移除或有新的取快照请求；
 * reset 之后原订阅已经结束，不重试就会停在旧树上。
 */
export async function loadTree(source: string): Promise<void> {
  const mine = (generation.get(source) ?? 0) + 1; generation.set(source, mine);
  clearTimeout(timers.get(source)); timers.delete(source);
  recentSince = Date.now() - RECENT_MS;
  treeStatus.set((s) => ({ ...s, [source]: { loading: true, ...(s[source]?.error ? { error: s[source]!.error } : {}) } }));
  try {
    const openNodeIds = pins(source).request();
    const snapshot = await api<TreeSnapshot>(base(source) + "/snapshot", { openNodeIds, recentSince: new Date(recentSince).toISOString() });
    if (generation.get(source) !== mine) return;
    tree(source).load(snapshot); retries.delete(source); awaiting.delete(source);
    const present = new Set(snapshot.nodes.map((node) => node.id));
    pins(source).loaded(openNodeIds, (id) => present.has(id));
    unsubscribers.get(source)?.();
    unsubscribers.set(source, ws.subscribeTree(source, () => { const t = trees.get().get(source); return t?.epoch ? { epoch: t.epoch, revision: t.revision } : null; }, (change) => onChange(source, change)));
    treeStatus.set((s) => ({ ...s, [source]: { loading: false } }));
    trees.touch();
    pinMissingParents();
  } catch (error) {
    if (generation.get(source) !== mine) return;
    // 不提供会话树的插件没有节点，不算错误。
    const missing = error instanceof ApiError && error.status === 404;
    if (missing) { tree(source).clear(); awaiting.delete(source); }
    treeStatus.set((s) => ({ ...s, [source]: { loading: false, ...(missing ? {} : { error: `${(error as Error).message}（正在重试）` }) } }));
    trees.touch();
    if (!missing && (source === "pane" || activeSources().includes(source))) {
      const attempt = retries.get(source) ?? 0; retries.set(source, attempt + 1);
      scheduleLoad(source, Math.min(10000, 1000 * 2 ** attempt));
    }
  }
}

/** 合并短时间内的多次重取（reset、补取祖先）。 */
function scheduleLoad(source: string, delay = 50): void {
  clearTimeout(timers.get(source));
  timers.set(source, setTimeout(() => { timers.delete(source); void loadTree(source); }, delay));
}

function onChange(source: string, change: TreeChange): void {
  const result = tree(source).apply(change, hot(source));
  if (result === "reset") { pins(source).retryMissing(); scheduleLoad(source); return; }
  if (result === "needsAncestors" && change.type === "upsert") { pins(source).open(change.node.id); scheduleLoad(source, 300); return; }
  if (result === "applied") { trees.touch(); if (change.type === "upsert") pinMissingParents(); }
}

/**
 * 插件节点挂在其他来源（主会话或另一个插件）未加载的节点下时，把该父节点加入其来源快照的打开列表并重取；
 * 来源仍给不出该节点时才归入“未归属”，之后不再为它重取（见 TreePins）。不再被引用的父节点从打开列表移除。
 */
function pinMissingParents(): void {
  const all = trees.get(); const reload = new Set<string>();
  const referenced = new Map<string, Set<string>>();
  for (const [source, t] of all) {
    if (source === "pane") continue;
    for (const node of t.nodes.values()) {
      const parentId = node.parentId; if (!parentId) continue;
      const parentSource = parentId.slice(0, parentId.indexOf(":"));
      if (parentSource === source) continue;
      let refs = referenced.get(parentSource); if (!refs) { refs = new Set(); referenced.set(parentSource, refs); } refs.add(parentId);
      if (!all.get(parentSource)?.epoch || findIn(all, parentId) || !pins(parentSource).wantParent(parentId)) continue;
      reload.add(parentSource);
      let set = awaiting.get(parentSource); if (!set) { set = new Set(); awaiting.set(parentSource, set); } set.add(parentId);
    }
  }
  for (const [source, value] of pinned) value.prune(referenced.get(source) ?? new Set());
  for (const source of reload) scheduleLoad(source, 100);
}

/** 父节点所在来源已为它重取快照、结果还没到。 */
export function awaitingParent(parentId: string): boolean {
  return awaiting.get(parentId.slice(0, parentId.indexOf(":")))?.has(parentId) ?? false;
}

/** 浏览器打开的节点加入该来源的打开列表，下次快照时保证它和它的祖先都在。 */
export function pinNode(source: string, nodeId: string): void { pins(source).open(nodeId); }

/** 展开“历史”：分页加载某个父节点的子节点。页的修订号超前于订阅时，等订阅追上，超过 5 秒按 reset 处理。 */
export async function loadChildren(source: string, parentId: string): Promise<void> {
  const t = tree(source); const epoch = t.epoch; if (!epoch || t.stale) return;
  const cursor = t.listed.get(parentId)?.cursor;
  if (t.listed.get(parentId)?.done) return;
  // 请求发出后树被 reset 或重新加载过（即使 epoch 相同），这一页按旧状态取得，丢弃。
  const loaded = t.generation;
  const current = () => trees.get().get(source) === t && t.generation === loaded && !t.stale && t.epoch === epoch;
  const query = new URLSearchParams({ parentId, epoch, limit: "50", ...(cursor ? { cursor } : {}) });
  let page: TreeChildrenPage;
  try { page = await api<TreeChildrenPage>(`${base(source)}/children?${query}`); }
  catch (error) { if (current()) toast(`加载历史失败：${(error as Error).message}`, "error"); return; }
  if (!current()) return;
  if ("reset" in page) { scheduleLoad(source); return; }
  const deadline = Date.now() + 5000;
  while (page.revision > t.revision) {
    if (!current()) return;
    if (Date.now() > deadline) { scheduleLoad(source); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!current()) return;
  t.mergePage(parentId, page.nodes, page.revision, page.nextCursor);
  trees.touch();
}

/** 连接建立或插件列表变化后，为 pane 和每个活动插件取快照；已停用插件的节点移除。 */
export function syncSources(): void {
  const sources = new Set(["pane", ...activeSources()]);
  for (const source of [...trees.get().keys()]) if (!sources.has(source)) {
    unsubscribers.get(source)?.(); unsubscribers.delete(source); trees.get().delete(source);
    generation.set(source, (generation.get(source) ?? 0) + 1);
    clearTimeout(timers.get(source)); timers.delete(source); retries.delete(source); awaiting.delete(source);
  }
  for (const source of sources) if (!trees.get().get(source)?.epoch && !treeStatus.get()[source]?.loading) void loadTree(source);
  trees.touch();
}

/** 侧栏的刷新按钮：重新读取存储目录（终端里新建的会话）并重取全部来源。 */
export function reloadAll(): void {
  for (const source of new Set(["pane", ...activeSources()])) { pins(source).retryMissing(); void loadTree(source); }
}

/** 按 id 找节点。节点 id 以来源为前缀。 */
export function findNode(id: string): TreeNode | undefined { return findIn(trees.get(), id); }

/** 插件节点中 originToolCall 指向该会话工具调用的节点。 */
export function nodeForToolCall(source: string, sessionId: string, toolCallId: string): TreeNode | undefined {
  for (const [src, t] of trees.get()) {
    if (src === "pane") continue;
    for (const node of t.nodes.values()) {
      const origin = node.originToolCall;
      if (origin && origin.toolCallId === toolCallId && origin.sessionRef.source === source && origin.sessionRef.id === sessionId) return node;
    }
  }
  return undefined;
}
