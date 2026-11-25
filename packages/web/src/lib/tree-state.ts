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
  version = 0;
  constructor(readonly source: string) {}

  load(snapshot: TreeSnapshot): void {
    this.epoch = snapshot.epoch; this.revision = snapshot.revision;
    this.nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    this.tombstones.clear(); this.listed.clear();
    this.foreign = { ...(snapshot.foreignChildCounts ?? {}) };
    this.version++;
  }

  clear(): void {
    this.epoch = null; this.revision = 0; this.nodes.clear(); this.tombstones.clear(); this.listed.clear(); this.foreign = {}; this.version++;
  }

  private known(id: string): number {
    return this.nodes.get(id)?.revision ?? this.tombstones.get(id) ?? -1;
  }

  /** 应用订阅推来的一条变更。冷节点的父节点尚未完整加载时不显示，等展开“历史”时再取。 */
  apply(change: TreeChange, hot: (node: TreeNode) => boolean): ChangeResult {
    if (change.type === "reset") return "reset";
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
    for (const node of nodes) if (node.revision > this.known(node.id)) { this.nodes.set(node.id, node); this.tombstones.delete(node.id); }
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
