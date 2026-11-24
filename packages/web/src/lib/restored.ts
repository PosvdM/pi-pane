// 输入框草稿的保存，以及停止或关闭时清出的排队草稿（architecture.md“取回草稿的交付”）。
// 清出的草稿一律放回发起请求时所在会话的输入框，不经确认框：该会话的输入框在本标签页挂载时直接放回；
// 未挂载时每批存成一条独立的待放回记录，输入框挂载时取走。
// localStorage 写入失败（如超出配额）时记录暂存在内存，只保留到页面关闭前，由输入框显示错误提示。
// 纯逻辑，Storage 由调用方传入，可在 Node.js 中测试。
import { isEmpty, normalize } from "./draft.ts";
import { Store } from "./store.ts";
import type { DraftNode } from "./types.ts";

/** uncertain：扩展改写后归属不明、可能已经发送的草稿。 */
export interface RestoredDraft { nodes: DraftNode[]; uncertain: boolean }
/** 输入框接收草稿的回调；返回前须调用 saveDraft 保存输入框内容，之后才删除待放回记录。 */
export type DraftSink = (drafts: RestoredDraft[]) => void;
interface Batch { at: number; drafts: RestoredDraft[] }

export const draftKey = (sessionId: string) => `pi-pane.draft.${sessionId}`;
export const batchPrefix = (sessionId: string) => `pi-pane.restored.${sessionId}.`;
export const noticeKey = (sessionId: string) => `pi-pane.restored-notice.${sessionId}`;

/** 未能写入 localStorage 的记录：键 → 所属会话与值。读取时优先于 localStorage。 */
const memory = new Map<string, { sessionId: string; value: string }>();
/** 有记录只保存在内存中的会话。 */
export const unsavedSessions = new Store<ReadonlySet<string>>(new Set());
let unloadGuard = false;

function changed(): void {
  unsavedSessions.set(new Set([...memory.values()].map((entry) => entry.sessionId)));
  // 关闭或刷新页面会丢掉内存中的记录，请浏览器先确认。
  if (memory.size && !unloadGuard && typeof window !== "undefined") {
    unloadGuard = true;
    window.addEventListener("beforeunload", (event) => { if (memory.size) event.preventDefault(); });
  }
}

/** 写入或删除一条记录；写入失败时保存在内存并返回 false，不抛错。 */
function persist(storage: Storage, sessionId: string, key: string, value: string | null): boolean {
  const had = memory.delete(key);
  try {
    if (value === null) storage.removeItem(key); else storage.setItem(key, value);
    if (had) changed();
    return true;
  } catch {
    if (value !== null) memory.set(key, { sessionId, value });
    changed();
    return false;
  }
}
function read(storage: Storage, key: string): string | null {
  return memory.get(key)?.value ?? storage.getItem(key);
}
function keys(storage: Storage, prefix: string): string[] {
  const found = new Set([...memory.keys()].filter((key) => key.startsWith(prefix)));
  for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(prefix)) found.add(key); }
  return [...found];
}

export function loadDraft(storage: Storage, sessionId: string): DraftNode[] {
  try { const nodes = JSON.parse(read(storage, draftKey(sessionId)) ?? "[]"); return Array.isArray(nodes) ? nodes : []; }
  catch { return []; }
}
/** 保存输入框草稿，空草稿删除记录。返回是否已写入 localStorage。 */
export function saveDraft(storage: Storage, sessionId: string, nodes: DraftNode[]): boolean {
  return persist(storage, sessionId, draftKey(sessionId), isEmpty(nodes) ? null : JSON.stringify(nodes));
}

/** 该会话输入框中仍待用户检查的归属不明草稿条数。 */
export function loadNotice(storage: Storage, sessionId: string): number {
  return Math.max(0, Number(read(storage, noticeKey(sessionId))) || 0);
}
export function saveNotice(storage: Storage, sessionId: string, count: number): boolean {
  return persist(storage, sessionId, noticeKey(sessionId), count > 0 ? String(count) : null);
}

const sinks = new Map<string, DraftSink>();

/**
 * 把一次停止或关闭清出的草稿交给 sessionId 的输入框。返回 composer：已放进本标签页挂载的输入框；
 * stored：已存入待放回记录；memory：localStorage 写入失败，暂存在内存；none：没有非空草稿。
 */
export function deliverRestored(storage: Storage, sessionId: string, drafts: RestoredDraft[]): "composer" | "stored" | "memory" | "none" {
  const kept = drafts.filter((draft) => !isEmpty(draft.nodes));
  if (!kept.length) return "none";
  const sink = sinks.get(sessionId);
  if (sink) { sink(kept); return "composer"; }
  // 每批一个键，写入不需要读取旧值，取走时也只删除读到的键，跨标签页不会覆盖或误删其他批次。
  const batch: Batch = { at: Date.now(), drafts: kept };
  const key = batchPrefix(sessionId) + `${batch.at}-${Math.random().toString(36).slice(2, 10)}`;
  return persist(storage, sessionId, key, JSON.stringify(batch)) ? "stored" : "memory";
}

/**
 * 把该会话的全部待放回记录交给输入框，之后只删除本次读到的记录。后清出的批次排在前面，
 * 与输入框挂载时逐批放到现有草稿之前的结果一致。输入框写入抛错时保留记录。
 */
export function takePending(storage: Storage, sessionId: string, sink: DraftSink): boolean {
  const batches: { key: string; batch: Batch }[] = [];
  for (const key of keys(storage, batchPrefix(sessionId))) {
    try {
      const batch = JSON.parse(read(storage, key) ?? "null");
      if (batch && Array.isArray(batch.drafts) && batch.drafts.every((d: any) => Array.isArray(d?.nodes))) {
        batches.push({ key, batch: { at: Number(batch.at) || 0, drafts: batch.drafts.map((d: any) => ({ nodes: normalize(d.nodes), uncertain: d.uncertain === true })) } });
        continue;
      }
    } catch { /* 损坏的记录按无效处理。 */ }
    persist(storage, sessionId, key, null);
  }
  if (!batches.length) return false;
  batches.sort((a, b) => b.batch.at - a.batch.at || (a.key < b.key ? 1 : -1));
  sink(batches.flatMap(({ batch }) => batch.drafts));
  for (const { key } of batches) persist(storage, sessionId, key, null);
  return true;
}

/** 输入框挂载时登记；返回注销函数。待放回记录由调用方用 takePending 取走。 */
export function attachComposer(sessionId: string, sink: DraftSink): () => void {
  sinks.set(sessionId, sink);
  return () => { if (sinks.get(sessionId) === sink) sinks.delete(sessionId); };
}
