// 输入框草稿的保存，以及停止或关闭时清出的排队草稿（architecture.md“取回草稿的交付”）。
// 清出的草稿一律放回发起请求时所在会话的输入框，不经确认框：该会话的输入框在本标签页挂载时直接放回；
// 未挂载时每批存成一条独立的待放回记录，输入框挂载时取走。
// localStorage 写入失败（如超出配额）时记录暂存在内存，只保留到页面关闭前，由输入框显示错误提示。
// 纯逻辑，Storage 由调用方传入，可在 Node.js 中测试。
import { isEmpty, normalize, prependDrafts } from "./draft.ts";
import { Store } from "./store.ts";
import type { DraftNode } from "./types.ts";

/** uncertain：扩展改写或追加消息后归属不明、可能已经发送的草稿。 */
export interface RestoredDraft { nodes: DraftNode[]; uncertain: boolean }
/** 本标签页挂载的输入框。deliver 把草稿放在现有内容之前，返回前须保存输入框内容，之后才删除待放回记录。 */
export interface ComposerHandle {
  deliver: (drafts: RestoredDraft[]) => void;
  read: () => DraftNode[];
  /** 替换输入框内容并立即保存。 */
  write: (nodes: DraftNode[]) => void;
}
interface Batch { at: number; drafts: RestoredDraft[] }

export const draftKey = (sessionId: string) => `pi-pane.draft.${sessionId}`;
export const uncertainKey = (sessionId: string) => `pi-pane.uncertain.${sessionId}`;
/**
 * 待放回记录的键前缀。取走时按前缀扫描，会话 id 编码后不含分隔符“.”，
 * 一个会话的前缀不会是另一个会话键的前缀（例如 a 与 a.b）。
 */
export const batchPrefix = (sessionId: string) => `pi-pane.restored.${encodeURIComponent(sessionId).replace(/\./g, "%2E")}.`;

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

function loadNodesList(storage: Storage, key: string): unknown[] {
  try { const value = JSON.parse(read(storage, key) ?? "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
export function loadDraft(storage: Storage, sessionId: string): DraftNode[] {
  return loadNodesList(storage, draftKey(sessionId)) as DraftNode[];
}
/** 保存输入框草稿，空草稿删除记录。返回是否已写入 localStorage。 */
export function saveDraft(storage: Storage, sessionId: string, nodes: DraftNode[]): boolean {
  return persist(storage, sessionId, draftKey(sessionId), isEmpty(nodes) ? null : JSON.stringify(nodes));
}

/** 放回输入框、仍待用户检查的归属不明草稿。 */
export function loadUncertain(storage: Storage, sessionId: string): DraftNode[][] {
  return loadNodesList(storage, uncertainKey(sessionId)).filter((nodes): nodes is DraftNode[] => Array.isArray(nodes)).map(normalize);
}
export function saveUncertain(storage: Storage, sessionId: string, drafts: DraftNode[][]): boolean {
  return persist(storage, sessionId, uncertainKey(sessionId), drafts.length ? JSON.stringify(drafts) : null);
}

/** 草稿的比较形式：图片写成不会出现在正文中的标记。 */
const flat = (nodes: DraftNode[]) => nodes.map((node) => node.type === "text" ? node.text : `\u0000${node.assetId}\u0000`).join("");
/**
 * 输入框内容中仍原样保留的归属不明草稿。删除或改动过的草稿视为用户已处理，不再计入；
 * 首尾空白不参与比较，内容相同的多条按出现次数计。
 */
export function remainingUncertain(content: DraftNode[], drafts: DraftNode[][]): DraftNode[][] {
  let text = flat(content);
  return drafts.filter((draft) => {
    const needle = flat(draft).trim();
    const at = needle ? text.indexOf(needle) : -1;
    if (at < 0) return false;
    text = text.slice(0, at) + "\u0001" + text.slice(at + needle.length);
    return true;
  });
}

const composers = new Map<string, ComposerHandle>();
/** 正在等待结果的提交：各自记录等待期间放回同一会话输入框的草稿，提交结束后注销。 */
export interface RestoreWatch { sessionId: string; restored: DraftNode[][][] }
const watches = new Set<RestoreWatch>();

function handOver(sessionId: string, composer: ComposerHandle, drafts: RestoredDraft[]): void {
  composer.deliver(drafts);
  for (const watch of watches) if (watch.sessionId === sessionId) watch.restored.push(drafts.map((draft) => draft.nodes));
}

/**
 * 把一次停止或关闭清出的草稿交给 sessionId 的输入框。返回 composer：已放进本标签页挂载的输入框；
 * stored：已存入待放回记录；memory：localStorage 写入失败，暂存在内存；none：没有非空草稿。
 */
export function deliverRestored(storage: Storage, sessionId: string, drafts: RestoredDraft[]): "composer" | "stored" | "memory" | "none" {
  const kept = drafts.filter((draft) => !isEmpty(draft.nodes));
  if (!kept.length) return "none";
  const composer = composers.get(sessionId);
  if (composer) { handOver(sessionId, composer, kept); return "composer"; }
  // 每批一个键，写入不需要读取旧值，取走时也只删除读到的键，跨标签页不会覆盖或误删其他批次。
  // 时间取严格大于已有批次的值，同一毫秒内后到的批次也排在前面。
  const prefix = batchPrefix(sessionId);
  const last = Math.max(0, ...keys(storage, prefix).map((key) => Number(key.slice(prefix.length).split("-")[0]) || 0));
  const batch: Batch = { at: Math.max(Date.now(), last + 1), drafts: kept };
  const key = prefix + `${batch.at}-${Math.random().toString(36).slice(2, 10)}`;
  return persist(storage, sessionId, key, JSON.stringify(batch)) ? "stored" : "memory";
}

/**
 * 把该会话的全部待放回记录交给本标签页挂载的输入框，之后只删除本次读到的记录。后清出的批次排在前面，
 * 与输入框挂载时逐批放到现有草稿之前的结果一致。输入框未挂载时不取；写入抛错时保留记录。
 */
export function takePending(storage: Storage, sessionId: string): boolean {
  const composer = composers.get(sessionId);
  if (!composer) return false;
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
  handOver(sessionId, composer, batches.flatMap(({ batch }) => batch.drafts));
  for (const { key } of batches) persist(storage, sessionId, key, null);
  return true;
}

/** 输入框挂载时登记；返回注销函数。待放回记录由调用方用 takePending 取走。 */
export function attachComposer(sessionId: string, composer: ComposerHandle): () => void {
  composers.set(sessionId, composer);
  return () => { if (composers.get(sessionId) === composer) composers.delete(sessionId); };
}

/** 提交命令或消息前登记，提交结束后必须调用 releaseWatch。 */
export function watchRestored(sessionId: string): RestoreWatch {
  const watch: RestoreWatch = { sessionId, restored: [] };
  watches.add(watch);
  return watch;
}
export function releaseWatch(watch: RestoreWatch): void {
  watches.delete(watch);
  watch.restored = [];
}

/**
 * 提交成功后从该会话的草稿中删除已提交的内容，不论用户是否已切到其他会话：输入框挂载时改输入框，
 * 否则改保存的草稿。等待期间放回的草稿在已提交内容之前，保留不删；草稿与“放回的草稿 + 已提交内容”
 * 不一致（等待期间用户编辑过）时不改动。返回是否已删除。
 */
export function clearSubmitted(storage: Storage, watch: RestoreWatch, submitted: DraftNode[]): boolean {
  let expected = normalize(submitted); let rest: DraftNode[] = [];
  for (const restored of watch.restored) { expected = prependDrafts(restored, expected); rest = prependDrafts(restored, rest); }
  releaseWatch(watch);
  const composer = composers.get(watch.sessionId);
  const content = normalize(composer ? composer.read() : loadDraft(storage, watch.sessionId));
  if (JSON.stringify(content) !== JSON.stringify(expected)) return false;
  if (composer) composer.write(rest); else saveDraft(storage, watch.sessionId, rest);
  return true;
}
