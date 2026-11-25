// 输入框草稿的保存、在途提交、停止与关闭的在途请求，以及停止、关闭或提交失败时取回的草稿（architecture.md“取回草稿的交付”）。
// 取回的草稿一律放回所属会话的输入框，不经确认框：该会话的输入框在本标签页挂载时直接放回；
// 未挂载时每批存成一条独立的待放回记录，输入框挂载时取走。
// localStorage 写入失败（如超出配额）时记录暂存在内存，只保留到页面关闭前，由输入框显示错误提示。
// 纯逻辑，Storage 和 Web Locks 由调用方传入，可在 Node.js 中测试。
import { isEmpty, normalize } from "./draft.ts";
import { Store } from "./store.ts";
import type { DraftNode } from "./types.ts";

/** uncertain：无法确认是否已经发送的草稿。 */
export interface RestoredDraft { nodes: DraftNode[]; uncertain: boolean }
/** 本标签页挂载的输入框。deliver 把草稿放在现有内容之前，返回前须保存输入框内容，之后才删除待放回记录。 */
export interface ComposerHandle { deliver: (drafts: RestoredDraft[], message: string | null) => void }
interface Batch { at: number; drafts: RestoredDraft[] }
/** 归属不明草稿的提示：放回时的条数与最近一次放回的时间。 */
export interface Notice { count: number; at: number }
/** 在途提交：提交时从输入框移出的内容。 */
export interface Flight { sessionId: string; key: string; nodes: DraftNode[]; at: number }
type Locks = Pick<LockManager, "request">;

/**
 * 键中的会话 id 编码：字母、数字、“_”“-”原样保留，其余每个 UTF-16 码元写成“%”加 4 位十六进制。
 * 编码可逆、不含分隔符“.”，对任意字符串（包括孤立代理项）都不抛错；按前缀查找时
 * 一个会话的前缀不会是另一个会话键的前缀（例如 a 与 a.b）。
 */
export const encodeId = (sessionId: string) => sessionId.replace(/[^A-Za-z0-9_-]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(4, "0"));
export const draftKey = (sessionId: string) => `pi-pane.draft.${sessionId}`;
export const noticeKey = (sessionId: string) => `pi-pane.notice.${sessionId}`;
export const batchPrefix = (sessionId: string) => `pi-pane.restored.${encodeId(sessionId)}.`;
export const flightPrefix = (sessionId: string) => `pi-pane.inflight.${encodeId(sessionId)}.`;
export const stopPrefix = (sessionId: string) => `pi-pane.stopflight.${encodeId(sessionId)}.`;
export const ackPrefix = (sessionId: string) => `pi-pane.ack.${encodeId(sessionId)}.`;

/** 在途提交的页面已关闭、但锁可能尚未登记的保护期，以及没有 Web Locks 时判定为遗留记录的时长（大于发送的网络重试上限）。 */
export const FLIGHT_GRACE_MS = 2_000;
export const FLIGHT_STALE_MS = 130_000;
/** 在途记录的锁被其他页面持有时的重查间隔：提交的页面仍在等待结果，或刷新时旧页面尚未释放锁。 */
export const FLIGHT_HELD_RECHECK_MS = 1_000;

/** 未能写入 localStorage 的记录：键 → 所属会话与值。读取时优先于 localStorage。 */
const memory = new Map<string, { sessionId: string; value: string }>();
/** 有记录只保存在内存中的会话。 */
export const unsavedSessions = new Store<ReadonlySet<string>>(new Set());
/** 提示记录变化的计数，输入框订阅后重新读取。 */
export const noticeChanged = new Store(0);
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
function parse(storage: Storage, key: string): any {
  try { return JSON.parse(read(storage, key) ?? "null"); } catch { return null; }
}
/** 前缀下各键的时间部分（键为“前缀 + 时间-随机串”），取严格大于已有记录的值，同一毫秒内的先后也能区分。 */
function nextAt(storage: Storage, prefix: string): number {
  const last = Math.max(0, ...keys(storage, prefix).map((key) => Number(key.slice(prefix.length).split("-")[0]) || 0));
  return Math.max(Date.now(), last + 1);
}
const suffix = (at: number) => `${at}-${Math.random().toString(36).slice(2, 10)}`;

export function loadDraft(storage: Storage, sessionId: string): DraftNode[] {
  const nodes = parse(storage, draftKey(sessionId));
  return Array.isArray(nodes) ? nodes : [];
}
/** 保存输入框草稿，空草稿删除记录。返回是否已写入 localStorage。 */
export function saveDraft(storage: Storage, sessionId: string, nodes: DraftNode[]): boolean {
  return persist(storage, sessionId, draftKey(sessionId), isEmpty(nodes) ? null : JSON.stringify(nodes));
}

export function loadNotice(storage: Storage, sessionId: string): Notice | null {
  const notice = parse(storage, noticeKey(sessionId));
  return notice && Number(notice.count) > 0 ? { count: Number(notice.count), at: Number(notice.at) || 0 } : null;
}
/** 放回归属不明的草稿时累加提示条数。 */
export function addNotice(storage: Storage, sessionId: string, count: number): void {
  const old = loadNotice(storage, sessionId);
  const notice: Notice = { count: (old?.count ?? 0) + count, at: Math.max(Date.now(), (old?.at ?? 0) + 1) };
  persist(storage, sessionId, noticeKey(sessionId), JSON.stringify(notice));
  noticeChanged.set((n) => n + 1);
}
/** 移除提示。给出 before 时只移除在该时间之前放回的提示，期间新放回的保留。 */
export function clearNotice(storage: Storage, sessionId: string, before?: number): void {
  const old = loadNotice(storage, sessionId);
  if (!old && !memory.has(noticeKey(sessionId)) && storage.getItem(noticeKey(sessionId)) === null) return;
  if (old && before !== undefined && old.at >= before) return;
  persist(storage, sessionId, noticeKey(sessionId), null);
  noticeChanged.set((n) => n + 1);
}

const composers = new Map<string, ComposerHandle>();

/**
 * 把取回的草稿交给 sessionId 的输入框。message 为放进本标签页挂载的输入框时显示的通知，null 表示不显示。
 * 返回 composer：已放进输入框；stored：已存入待放回记录；memory：localStorage 写入失败，暂存在内存；none：没有非空草稿。
 */
export function deliverRestored(storage: Storage, sessionId: string, drafts: RestoredDraft[], message: string | null = "排队中的消息已放回输入框"): "composer" | "stored" | "memory" | "none" {
  const kept = drafts.filter((draft) => !isEmpty(draft.nodes));
  if (!kept.length) return "none";
  const composer = composers.get(sessionId);
  if (composer) { composer.deliver(kept, message); return "composer"; }
  // 每批一个键，写入不需要读取旧值，取走时也只删除读到的键，跨标签页不会覆盖或误删其他批次。
  const prefix = batchPrefix(sessionId);
  const batch: Batch = { at: nextAt(storage, prefix), drafts: kept };
  return persist(storage, sessionId, prefix + suffix(batch.at), JSON.stringify(batch)) ? "stored" : "memory";
}

/**
 * 把该会话的全部待放回记录交给本标签页挂载的输入框，之后只删除本次读到的记录。后存入的批次排在前面，
 * 与输入框挂载时逐批放到现有草稿之前的结果一致。输入框未挂载时不取；写入抛错时保留记录。
 */
export function takePending(storage: Storage, sessionId: string): boolean {
  const composer = composers.get(sessionId);
  if (!composer) return false;
  const batches: { key: string; batch: Batch }[] = [];
  for (const key of keys(storage, batchPrefix(sessionId))) {
    const batch = parse(storage, key);
    if (batch && Array.isArray(batch.drafts) && batch.drafts.every((d: any) => Array.isArray(d?.nodes))) {
      batches.push({ key, batch: { at: Number(batch.at) || 0, drafts: batch.drafts.map((d: any) => ({ nodes: normalize(d.nodes), uncertain: d.uncertain === true })) } });
    } else persist(storage, sessionId, key, null);
  }
  if (!batches.length) return false;
  batches.sort((a, b) => b.batch.at - a.batch.at || (a.key < b.key ? 1 : -1));
  composer.deliver(batches.flatMap(({ batch }) => batch.drafts), "取回的消息已放回输入框");
  for (const { key } of batches) persist(storage, sessionId, key, null);
  return true;
}

/** 输入框挂载时登记；返回注销函数。待放回记录由调用方用 takePending 取走。 */
export function attachComposer(sessionId: string, composer: ComposerHandle): () => void {
  composers.set(sessionId, composer);
  return () => { if (composers.get(sessionId) === composer) composers.delete(sessionId); };
}

/** 本页面正在等待结果的在途提交：键 → 释放 Web Lock 的回调。 */
const live = new Map<string, () => void>();
/** 当前环境的 Web Locks；不可用时（例如非安全上下文）为 null。 */
const defaultLocks = (): Locks | null => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? null;

/**
 * 提交前登记在途提交：内容存入 localStorage，并在提交期间持有以该键命名的 Web Lock，
 * 页面关闭时锁随之释放，其他页面据此判断记录已无人等待。调用方随后清空输入框，结束时必须调用 finishSubmit。
 */
export function beginSubmit(storage: Storage, sessionId: string, nodes: DraftNode[], locks: Locks | null = defaultLocks()): Flight {
  const prefix = flightPrefix(sessionId);
  const at = nextAt(storage, prefix);
  const flight: Flight = { sessionId, key: prefix + suffix(at), nodes: normalize(nodes), at };
  persist(storage, sessionId, flight.key, JSON.stringify({ at, nodes: flight.nodes }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  live.set(flight.key, release);
  void locks?.request(flight.key, () => held);
  return flight;
}

/**
 * 结束在途提交。sent：已送达，丢弃记录；failed：确定没有执行，原样放回该会话；
 * unknown：结果无法确认，放回并标记归属不明。放回不覆盖输入框中的现有内容，之后才删除记录。
 */
export function finishSubmit(storage: Storage, flight: Flight, end: "sent" | "failed" | "unknown"): void {
  if (end !== "sent") deliverRestored(storage, flight.sessionId, [{ nodes: flight.nodes, uncertain: end === "unknown" }], end === "unknown" ? "结果无法确认的消息已放回输入框" : null);
  persist(storage, flight.sessionId, flight.key, null);
  live.get(flight.key)?.();
  live.delete(flight.key);
}

/**
 * 取回已无页面等待结果的在途提交（例如提交后刷新或关闭了页面），按结果无法确认放回该会话。
 * 有 Web Locks 时以锁是否仍被持有判断：锁被持有时不取走，稍后重查，锁释放后记录仍在才取回；没有 Web Locks 时只取超过 FLIGHT_STALE_MS 的记录。
 * 返回还需多少毫秒后再检查（有尚在保护期内或锁被持有的记录时），没有则为 null。
 */
export async function recoverFlights(storage: Storage, sessionId: string, locks: Locks | null = defaultLocks(), now = Date.now()): Promise<number | null> {
  let recheck: number | null = null;
  for (const key of keys(storage, flightPrefix(sessionId))) {
    if (live.has(key)) continue;
    const record = parse(storage, key);
    if (!record || !Array.isArray(record.nodes)) { persist(storage, sessionId, key, null); continue; }
    const age = now - (Number(record.at) || 0);
    const wait = (locks ? FLIGHT_GRACE_MS : FLIGHT_STALE_MS) - age;
    if (wait > 0) { recheck = Math.min(recheck ?? wait, wait); continue; }
    // 持有该记录的锁时取回。提交的页面仍在等待、另一页面正在取回、或刷新时旧页面尚未释放锁时拿不到锁，稍后重查。
    const recover = () => {
      // 等待锁期间记录可能已被结束或被其他页面取走。
      if (live.has(key) || read(storage, key) === null) return;
      deliverRestored(storage, sessionId, [{ nodes: normalize(record.nodes), uncertain: true }], "结果无法确认的消息已放回输入框");
      persist(storage, sessionId, key, null);
    };
    if (locks) await locks.request(key, { ifAvailable: true }, (lock) => {
      if (lock) recover();
      else if (read(storage, key) !== null) recheck = Math.min(recheck ?? FLIGHT_HELD_RECHECK_MS, FLIGHT_HELD_RECHECK_MS);
    });
    else recover();
  }
  return recheck;
}

/** 停止或关闭的在途请求：请求体原样保存，结果没有交到发起的页面时，之后的页面用同一 requestId 续取。 */
export interface StopFlight { sessionId: string; key: string; at: number; body: { requestId: string } & Record<string, unknown> }

/** 本标签页挂载着该会话的输入框。 */
export function isMounted(sessionId: string): boolean { return composers.has(sessionId); }
/** 本页面仍在等待该在途记录的结果。 */
export function isLive(key: string): boolean { return live.has(key); }

/**
 * 发送停止或关闭请求前登记在途请求：请求体存入 localStorage，等待结果期间持有以该键命名的 Web Lock。
 * 结束时调用 settleServerDrafts（得到结果）或 releaseStop（结果未知，留给 server-drafts.ts 续取）。
 */
export function beginStop(storage: Storage, sessionId: string, body: StopFlight["body"], locks: Locks | null = defaultLocks()): StopFlight {
  const prefix = stopPrefix(sessionId);
  const at = nextAt(storage, prefix);
  const flight: StopFlight = { sessionId, key: prefix + suffix(at), at, body };
  persist(storage, sessionId, flight.key, JSON.stringify({ at, sessionId, body }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  live.set(flight.key, release);
  void locks?.request(flight.key, () => held);
  return flight;
}
/** 本页面不再等待结果：释放锁，记录保留。 */
export function releaseStop(key: string): void {
  live.get(key)?.();
  live.delete(key);
}
/** 该会话的停止、关闭在途请求；损坏的记录清除。 */
export function stopFlights(storage: Storage, sessionId: string): StopFlight[] {
  const flights: StopFlight[] = [];
  for (const key of keys(storage, stopPrefix(sessionId))) {
    const record = parse(storage, key);
    if (record && typeof record.body?.requestId === "string") flights.push({ sessionId, key, at: Number(record.at) || 0, body: record.body });
    else persist(storage, sessionId, key, null);
  }
  return flights.sort((a, b) => a.at - b.at);
}

/** 已放回、尚未在服务端删除的服务端草稿记录：键 → 记录 id。 */
export function pendingAcks(storage: Storage, sessionId: string): { key: string; ids: string[] }[] {
  const acks: { key: string; ids: string[] }[] = [];
  for (const key of keys(storage, ackPrefix(sessionId))) {
    const record = parse(storage, key);
    if (Array.isArray(record?.ids) && record.ids.every((id: unknown) => typeof id === "string")) acks.push({ key, ids: record.ids });
    else persist(storage, sessionId, key, null);
  }
  return acks;
}
/** 服务端已删除记录后移除待删除登记。 */
export function clearAck(storage: Storage, sessionId: string, key: string): void { persist(storage, sessionId, key, null); }

/** 有停止在途请求或待删除登记的会话，网络恢复时逐个续取。 */
export function sessionsWithServerWork(storage: Storage): string[] {
  const sessions = new Set<string>();
  for (const prefix of ["pi-pane.stopflight.", "pi-pane.ack."]) {
    for (const key of keys(storage, prefix)) {
      const record = parse(storage, key);
      if (typeof record?.sessionId === "string") sessions.add(record.sessionId);
    }
  }
  return [...sessions];
}

/**
 * 放回服务端交出的清出草稿：先交给该会话的输入框或待放回记录，再登记要在服务端删除的记录 id，最后删除对应的停止在途记录。
 * 三步在同一个同步步骤中完成，并且先登记后删除：其他标签页任何时刻都能看到在途记录或待删除登记之一，不会把同一条记录再放回一次。
 */
export function settleServerDrafts(storage: Storage, sessionId: string, ids: string[], drafts: RestoredDraft[], message: string | null, flightKey?: string): void {
  deliverRestored(storage, sessionId, drafts, message);
  if (ids.length) {
    const prefix = ackPrefix(sessionId);
    persist(storage, sessionId, prefix + suffix(nextAt(storage, prefix)), JSON.stringify({ sessionId, ids }));
  }
  if (flightKey) { persist(storage, sessionId, flightKey, null); releaseStop(flightKey); }
}
