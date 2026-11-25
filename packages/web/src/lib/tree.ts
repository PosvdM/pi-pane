// 侧栏会话树：pi-pane 自己的主会话树（source = "pane"）与各插件的树合并显示。
// 每个来源先取热节点快照，再从快照游标订阅变更；冷节点在用户展开“历史”时分页加载（plugin-api.md“按需加载”“同步”）。
import { api, ApiError } from "./api.ts";
import { activeSources } from "./plugins.ts";
import { Store } from "./store.ts";
import { isHot, RECENT_MS, SourceTree } from "./tree-state.ts";
import type { TreeChange, TreeChildrenPage, TreeNode, TreeSnapshot } from "./types.ts";
import * as ws from "./ws.ts";

export interface TreeStatus { loading: boolean; error?: string }
/** 各来源的树；对象本身原地修改，变化后 touch。 */
export const trees = new Store<Map<string, SourceTree>>(new Map());
export const treeStatus = new Store<Record<string, TreeStatus>>({});

const pinned = new Map<string, Set<string>>();
const generation = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const unsubscribers = new Map<string, () => void>();
let recentSince = Date.now() - RECENT_MS;

function tree(source: string): SourceTree {
  let value = trees.get().get(source);
  if (!value) { value = new SourceTree(source); trees.get().set(source, value); }
  return value;
}
function pins(source: string): Set<string> {
  let set = pinned.get(source); if (!set) { set = new Set(); pinned.set(source, set); } return set;
}
const base = (source: string) => source === "pane" ? "/api/tree" : `/api/plugins/${encodeURIComponent(source)}/tree`;
const hot = (source: string) => (node: TreeNode) => isHot(node, recentSince, pins(source));

/** 取快照并从它的游标订阅。并发调用时只有最后一次能提交。 */
export async function loadTree(source: string): Promise<void> {
  const mine = (generation.get(source) ?? 0) + 1; generation.set(source, mine);
  recentSince = Date.now() - RECENT_MS;
  treeStatus.set((s) => ({ ...s, [source]: { loading: true } }));
  try {
    const snapshot = await api<TreeSnapshot>(base(source) + "/snapshot", { openNodeIds: [...pins(source)], recentSince: new Date(recentSince).toISOString() });
    if (generation.get(source) !== mine) return;
    tree(source).load(snapshot);
    unsubscribers.get(source)?.();
    unsubscribers.set(source, ws.subscribeTree(source, () => { const t = trees.get().get(source); return t?.epoch ? { epoch: t.epoch, revision: t.revision } : null; }, (change) => onChange(source, change)));
    treeStatus.set((s) => ({ ...s, [source]: { loading: false } }));
    trees.touch();
    if (source !== "pane") pinMissingParents();
  } catch (error) {
    if (generation.get(source) !== mine) return;
    // 不提供会话树的插件没有节点，不算错误。
    const missing = error instanceof ApiError && error.status === 404;
    if (missing) tree(source).clear();
    treeStatus.set((s) => ({ ...s, [source]: { loading: false, ...(missing ? {} : { error: (error as Error).message }) } }));
    trees.touch();
  }
}

/** 合并短时间内的多次重取（reset、补取祖先）。 */
function scheduleLoad(source: string, delay = 50): void {
  clearTimeout(timers.get(source));
  timers.set(source, setTimeout(() => { timers.delete(source); void loadTree(source); }, delay));
}

function onChange(source: string, change: TreeChange): void {
  const result = tree(source).apply(change, hot(source));
  if (result === "reset") { scheduleLoad(source); return; }
  if (result === "needsAncestors" && change.type === "upsert") { pins(source).add(change.node.id); scheduleLoad(source, 300); return; }
  if (result === "applied") { trees.touch(); if (source !== "pane" && change.type === "upsert") pinMissingParents(); }
}

/** 插件节点挂在没有加载的主会话下时，把该主会话加入 pane 快照的打开列表；pane 仍列不出的才归入“未归属”。 */
function pinMissingParents(): void {
  const pane = trees.get().get("pane"); if (!pane?.epoch) return;
  let added = false;
  for (const [source, t] of trees.get()) {
    if (source === "pane") continue;
    for (const node of t.nodes.values()) {
      if (node.parentId?.startsWith("pane:") && !pane.nodes.has(node.parentId) && !pins("pane").has(node.parentId)) { pins("pane").add(node.parentId); added = true; }
    }
  }
  if (added) scheduleLoad("pane", 100);
}

/** 浏览器打开的节点加入该来源的打开列表，下次快照时保证它和它的祖先都在。 */
export function pinNode(source: string, nodeId: string): void { pins(source).add(nodeId); }

/** 展开“历史”：分页加载某个父节点的子节点。页的修订号超前于订阅时，等订阅追上，超过 5 秒按 reset 处理。 */
export async function loadChildren(source: string, parentId: string): Promise<void> {
  const t = tree(source); const epoch = t.epoch; if (!epoch) return;
  const cursor = t.listed.get(parentId)?.cursor;
  if (t.listed.get(parentId)?.done) return;
  const query = new URLSearchParams({ parentId, epoch, limit: "50", ...(cursor ? { cursor } : {}) });
  const page = await api<TreeChildrenPage>(`${base(source)}/children?${query}`);
  if (t.epoch !== epoch) return;
  if ("reset" in page) { scheduleLoad(source); return; }
  const deadline = Date.now() + 5000;
  while (page.revision > t.revision) {
    if (Date.now() > deadline || t.epoch !== epoch) { scheduleLoad(source); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  t.mergePage(parentId, page.nodes, page.revision, page.nextCursor);
  trees.touch();
}

/** 连接建立或插件列表变化后，为 pane 和每个活动插件取快照；已停用插件的节点移除。 */
export function syncSources(): void {
  const sources = new Set(["pane", ...activeSources()]);
  for (const source of [...trees.get().keys()]) if (!sources.has(source)) {
    unsubscribers.get(source)?.(); unsubscribers.delete(source); trees.get().delete(source);
    generation.set(source, (generation.get(source) ?? 0) + 1);
  }
  for (const source of sources) if (!trees.get().get(source)?.epoch && !treeStatus.get()[source]?.loading) void loadTree(source);
  trees.touch();
}

/** 侧栏的刷新按钮：重新读取存储目录（终端里新建的会话）并重取全部来源。 */
export function reloadAll(): void { for (const source of new Set(["pane", ...activeSources()])) void loadTree(source); }

/** 按 id 找节点。节点 id 以来源为前缀。 */
export function findNode(id: string): TreeNode | undefined {
  for (const t of trees.get().values()) { const node = t.nodes.get(id); if (node) return node; }
  return undefined;
}

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
