import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { MainSessionInfo, TreeChange, TreeChildrenPage, TreeCursor, TreeNode, TreeSnapshot, TreeSnapshotRequest } from "@pi-pane/plugin-api";
import { assert } from "../errors.js";
import { fileKey } from "../store.js";

export interface MainTreeRow { info: MainSessionInfo; lastActivityAt?: string; messageCount?: number; holds?: { source: string; reason: string }[] }
export interface MainTreeOptions { load(): Promise<MainTreeRow[]>; current(): MainTreeRow[]; watch(listener: () => void): () => void }

/** 来源级游标覆盖完整主会话目录；快照只选择热节点及其祖先。 */
export class MainTree {
  private readonly epoch = randomUUID();
  private revision = 0;
  private nodes = new Map<string, TreeNode>();
  private changes: Exclude<TreeChange, { type: "reset" }>[] = [];
  private readonly listeners = new Set<(change: TreeChange) => void>();
  private readonly unwatch: () => void;
  private loading?: Promise<void>;
  private closed = false;
  private dirty = false;
  constructor(private readonly options: MainTreeOptions) {
    this.unwatch = options.watch(() => {
      if (this.closed || this.dirty) return;
      this.dirty = true;
      queueMicrotask(() => {
        this.dirty = false;
        if (!this.closed) { try { this.rebuild(options.current()); } catch (error) { console.error("主会话目录刷新失败：", error); } }
      });
    });
  }
  refresh(): Promise<void> {
    assert(!this.closed, "serverStopping", "会话树已关闭", 503);
    if (!this.loading) this.loading = (async () => {
      await this.options.load();
      // 存储读取期间会话可能启动或停止；最终使用同步目录的当前状态。
      if (!this.closed) this.rebuild(this.options.current());
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private rebuild(rows: MainTreeRow[]): void {
    const next = new Map<string, TreeNode>();
    const unassigned: TreeNode = { id: "pane:group:unassigned", source: "pane", kind: "group", parentId: null, title: "未归属", status: "idle", availability: "online", hasChildren: false, sortKey: "~unassigned", revision: 0, capabilities: [] };
    next.set(unassigned.id, unassigned);
    for (const row of rows) {
      const { info } = row;
      const cwd = path.resolve(info.cwd); const key = fileKey(cwd);
      const parentId = "pane:project:" + createHash("sha256").update(key).digest("hex");
      let project = next.get(parentId);
      if (!project) {
        project = { id: parentId, source: "pane", kind: "group", parentId: null, title: cwd, status: "idle", availability: "online", hasChildren: true, childCount: 0, sortKey: key, revision: 0, capabilities: [] };
        next.set(parentId, project);
      }
      project.childCount!++;
      next.set(info.nodeId, {
        id: info.nodeId, source: "pane", kind: "session", parentId, title: info.title, sessionRef: info.ref,
        status: info.status, availability: info.hosted ? "online" : "archived", hasChildren: false,
        sortKey: info.ref.id, revision: 0, capabilities: ["open", "subscribe", "send", ...(info.hosted ? ["abort"] : [])],
        ...(row.lastActivityAt === undefined ? {} : { lastActivityAt: row.lastActivityAt }),
        ...(row.messageCount === undefined ? {} : { messageCount: row.messageCount }),
        ...(row.holds?.length ? { statusDetail: row.holds.map((hold) => hold.reason).join("；") } : {}),
      });
    }
    const events: Exclude<TreeChange, { type: "reset" }>[] = [];
    for (const id of this.nodes.keys()) if (!next.has(id)) events.push({ type: "remove", id, revision: ++this.revision });
    for (const [id, node] of next) {
      const old = this.nodes.get(id);
      if (old && JSON.stringify({ ...old, revision: 0 }) === JSON.stringify(node)) node.revision = old.revision;
      else { node.revision = ++this.revision; events.push({ type: "upsert", revision: node.revision, node }); }
    }
    this.nodes = next;
    this.changes.push(...structuredClone(events));
    if (this.changes.length > 2000) this.changes.splice(0, this.changes.length - 2000);
    for (const event of events) for (const listener of [...this.listeners]) this.emit(listener, event);
  }
  private emit(listener: (change: TreeChange) => void, change: TreeChange): void {
    try { listener(structuredClone(change)); } catch (error) { console.error("主会话树监听失败：", error); }
  }
  async snapshot(request: TreeSnapshotRequest): Promise<TreeSnapshot> {
    assert(Array.isArray(request.openNodeIds) && request.openNodeIds.every((id) => typeof id === "string") && request.openNodeIds.length <= 1000 && Number.isFinite(Date.parse(request.recentSince)), "invalidTreeRequest", "树快照请求无效");
    await this.refresh();
    const selected = new Set(request.openNodeIds); const recent = Date.parse(request.recentSince);
    for (const node of this.nodes.values()) if (node.kind === "group" || ["running", "waiting", "paused"].includes(node.status) || node.lastActivityAt && Date.parse(node.lastActivityAt) > recent) selected.add(node.id);
    for (const id of selected) {
      let parent = this.nodes.get(id)?.parentId;
      while (parent) { selected.add(parent); parent = this.nodes.get(parent)?.parentId; }
    }
    return { source: "pane", epoch: this.epoch, revision: this.revision, nodes: structuredClone([...this.nodes.values()].filter((node) => selected.has(node.id))) };
  }
  async children(parentId: string, page: { epoch: string; cursor?: string; limit: number }): Promise<TreeChildrenPage> {
    assert(typeof parentId === "string" && typeof page.epoch === "string" && Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= 200, "invalidTreeRequest", "树分页请求无效");
    if (page.epoch !== this.epoch) return { reset: true, epoch: this.epoch };
    await this.refresh();
    let after: string | undefined;
    if (page.cursor !== undefined) {
      assert(typeof page.cursor === "string" && page.cursor.length <= 4096, "invalidTreeCursor", "树分页游标无效");
      let value: any;
      try { value = JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")); } catch { /* 下方统一拒绝不透明游标的畸形内容。 */ }
      assert(value?.epoch === this.epoch && value.parentId === parentId && typeof value.after === "string", "invalidTreeCursor", "树分页游标不属于当前父节点");
      after = value.after;
    }
    const available = [...this.nodes.values()].filter((node) => node.parentId === parentId && (after === undefined || node.sortKey > after)).sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
    const nodes = available.slice(0, page.limit);
    const nextCursor = available.length > nodes.length ? Buffer.from(JSON.stringify({ epoch: this.epoch, parentId, after: nodes.at(-1)!.sortKey })).toString("base64url") : undefined;
    return { epoch: this.epoch, revision: this.revision, nodes: structuredClone(nodes), ...(nextCursor ? { nextCursor } : {}) };
  }
  subscribe(after: TreeCursor, emit: (change: TreeChange) => void): () => void {
    assert(!this.closed, "serverStopping", "会话树已关闭", 503);
    assert(typeof after?.epoch === "string" && Number.isSafeInteger(after.revision) && after.revision >= 0, "invalidCursor", "树游标无效");
    const oldest = this.changes[0]?.revision ?? this.revision + 1;
    if (after.epoch !== this.epoch || after.revision > this.revision || after.revision < oldest - 1) { this.emit(emit, { type: "reset", epoch: this.epoch }); return () => {}; }
    const pending = this.changes.filter((change) => change.revision > after.revision);
    this.listeners.add(emit);
    for (const change of pending) this.emit(emit, change);
    return () => { this.listeners.delete(emit); };
  }
  close(): void { if (this.closed) return; this.closed = true; this.unwatch(); this.listeners.clear(); }
}
