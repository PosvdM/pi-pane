// 单个来源的会话树状态，按 plugin-api.md“同步”的规则合并快照、订阅变更和分页。不做网络请求，供 tree.ts 使用并可直接单测。
import type { TreeChange, TreeNode, TreeSnapshot } from "./types.ts";

export const RECENT_MS = 7 * 24 * 3600 * 1000;
const HOT = new Set(["running", "waiting", "paused"]);

/** 热节点：运行、等待或暂停中，最近活动晚于 recentSince，或在 pinned 中（浏览器打开着）。 */
export function isHot(node: TreeNode, recentSince: number, pinned: ReadonlySet<string>): boolean {
  if (pinned.has(node.id) || HOT.has(node.status)) return true;
  const active = node.lastActivityAt ? Date.parse(node.lastActivityAt) : NaN;
  return Number.isFinite(active) && active > recentSince;
}

export type ChangeResult = "applied" | "ignored" | "reset" | "needsAncestors";

export class SourceTree {
  epoch: string | null = null;
  /** 已知的最新来源级修订号（快照、订阅或已合并的分页）。 */
  revision = 0;
  nodes = new Map<string, TreeNode>();
  /** 被删除的节点及删除时的修订号，保留到下一次 reset，阻止更旧的 upsert 复活节点。 */
  tombstones = new Map<string, number>();
  /** 插件报告的、挂在其他来源节点下的子节点总数。 */
  foreign: Record<string, number> = {};
  /** 已分页加载过的父节点；done 表示全部子节点都已加载，之后新出现的子节点直接显示。 */
  listed = new Map<string, { cursor?: string; done: boolean }>();
  /**
   * 来自快照或分页的节点 id。foreignChildCounts 只在快照时更新，计算其他来源父节点下的“历史（N）”时
   * 只扣除这些节点；订阅推来的新节点不在快照的数目里，不能拿来抵扣。
   */
  baseline = new Set<string>();
  /** 每次 load 或 clear 加一；分页请求据此丢弃发出后树已被重建的结果。 */
  generation = 0;
  /** 收到 reset、新快照还没到：期间的分页结果作废，避免把快照已排除的节点插回。 */
  stale = false;
  version = 0;
  readonly source: string;
  constructor(source: string) { this.source = source; }

  load(snapshot: TreeSnapshot): void {
    this.epoch = snapshot.epoch; this.revision = snapshot.revision;
    this.nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    this.baseline = new Set(this.nodes.keys());
    this.tombstones.clear(); this.listed.clear();
    this.foreign = { ...(snapshot.foreignChildCounts ?? {}) };
    this.generation++; this.stale = false; this.version++;
  }

  clear(): void {
    this.epoch = null; this.revision = 0; this.nodes.clear(); this.tombstones.clear(); this.listed.clear(); this.baseline.clear(); this.foreign = {};
    this.generation++; this.stale = false; this.version++;
  }

  private known(id: string): number {
    return this.nodes.get(id)?.revision ?? this.tombstones.get(id) ?? -1;
  }

  /** 应用订阅推来的一条变更。冷节点的父节点尚未完整加载时不显示，等展开“历史”时再取。 */
  apply(change: TreeChange, hot: (node: TreeNode) => boolean): ChangeResult {
    if (change.type === "reset") { this.stale = true; return "reset"; }
    if (change.revision > this.revision) this.revision = change.revision;
    if (change.type === "remove") {
      if (change.revision <= this.known(change.id)) return "ignored";
      this.nodes.delete(change.id); this.tombstones.set(change.id, change.revision); this.version++;
      return "applied";
    }
    const node = change.node;
    if (change.revision <= this.known(node.id)) return "ignored";
    const parentKnown = node.parentId === null || !node.parentId.startsWith(this.source + ":") || this.nodes.has(node.parentId);
    if (!this.nodes.has(node.id)) {
      const listed = node.parentId !== null && this.listed.get(node.parentId)?.done === true;
      if (!listed && !hot(node)) return "ignored";
      if (!parentKnown) return "needsAncestors";
    }
    this.nodes.set(node.id, { ...node, revision: change.revision });
    this.tombstones.delete(node.id); this.version++;
    return "applied";
  }

  /** 合并 children() 的一页；页里比本地已知修订号旧的节点不覆盖订阅推来的新内容。 */
  mergePage(parentId: string, nodes: TreeNode[], pageRevision: number, nextCursor?: string): void {
    for (const node of nodes) {
      if (node.revision > this.known(node.id)) { this.nodes.set(node.id, node); this.tombstones.delete(node.id); }
      if (this.nodes.has(node.id)) this.baseline.add(node.id);
    }
    if (pageRevision > this.revision) this.revision = pageRevision;
    this.listed.set(parentId, { ...(nextCursor ? { cursor: nextCursor } : {}), done: !nextCursor });
    this.version++;
  }

  children(parentId: string | null): TreeNode[] {
    const list: TreeNode[] = [];
    for (const node of this.nodes.values()) if (node.parentId === parentId) list.push(node);
    return list.sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);
  }
}

const sourceOf = (id: string) => id.slice(0, Math.max(0, id.indexOf(":")));

export function findIn(trees: ReadonlyMap<string, SourceTree>, id: string): TreeNode | undefined {
  const own = trees.get(sourceOf(id))?.nodes.get(id);
  if (own) return own;
  for (const t of trees.values()) { const node = t.nodes.get(id); if (node) return node; }
  return undefined;
}

/** 某个节点在各来源下的子节点：父节点可以属于其他来源（如插件节点挂在主会话或另一个插件的节点下）。 */
export function childrenAcross(trees: ReadonlyMap<string, SourceTree>, parentId: string): TreeNode[] {
  const list: TreeNode[] = [];
  for (const t of trees.values()) list.push(...t.children(parentId));
  return list;
}

export interface HiddenChildren {
  /** 已知数目的未加载子节点数。 */
  count: number;
  /** 有未加载的子节点但数目未知（hasChildren 为 true、没有 childCount）：只显示“历史”。 */
  unknown: boolean;
  /** 展开“历史”时要分页的来源。 */
  sources: string[];
}

/**
 * 节点下尚未加载的子节点（plugin-api.md“按需加载”）。
 * - 同一来源：按父节点的 hasChildren/childCount，扣除该来源已加载的子节点；childCount 由来源随推送更新。
 * - 其他来源：按各来源快照报告的 foreignChildCounts，每个来源只扣除自己经快照或分页取到的子节点。
 * 某个来源对该父节点已分页到最后一页时，它不再有未加载的子节点。
 */
export function hiddenChildren(trees: ReadonlyMap<string, SourceTree>, node: TreeNode): HiddenChildren {
  const result: HiddenChildren = { count: 0, unknown: false, sources: [] };
  const own = trees.get(node.source);
  if (own && node.hasChildren && !own.listed.get(node.id)?.done) {
    if (node.childCount === undefined) { result.unknown = true; result.sources.push(node.source); }
    else {
      const hidden = node.childCount - own.children(node.id).length;
      if (hidden > 0) { result.count += hidden; result.sources.push(node.source); }
    }
  }
  for (const [source, t] of trees) {
    if (source === node.source) continue;
    const total = t.foreign[node.id];
    if (!total || t.listed.get(node.id)?.done) continue;
    const hidden = total - t.children(node.id).filter((child) => t.baseline.has(child.id)).length;
    if (hidden > 0) { result.count += hidden; result.sources.push(source); }
  }
  return result;
}

/**
 * 节点是否放进“未归属”分组：父节点指向 pane:group:unassigned，父节点所在来源已加载却没有该节点（或该来源不存在），
 * 或沿父链回到自己（循环）。waiting(parentId) 为 true 表示已为该父节点重取快照、结果未到，暂不归入。
 */
export function unassigned(trees: ReadonlyMap<string, SourceTree>, node: TreeNode, waiting: (parentId: string) => boolean = () => false): boolean {
  const parentId = node.parentId;
  if (parentId === null) return false;
  if (parentId === "pane:group:unassigned") return true;
  let parent = findIn(trees, parentId);
  if (!parent) {
    const t = trees.get(sourceOf(parentId));
    return (!t || !!t.epoch) && !waiting(parentId);
  }
  for (let steps = 0; parent && steps < 1000; steps++) {
    if (parent.id === node.id) return true;
    parent = parent.parentId === null ? undefined : findIn(trees, parent.parentId);
  }
  return false;
}
