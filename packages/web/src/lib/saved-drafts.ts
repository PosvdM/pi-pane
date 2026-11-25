// 服务端保存的清出草稿（architecture.md“服务端暂存的清出草稿”）。服务端记录是这些草稿唯一的权威副本：
// 浏览器只读取列表、显示在该会话的待取回条中，由用户显式领取；领取在服务端原子地删除记录，只有第一个领取者拿到内容。
// 发起停止或关闭的页面收到结果时按 requestId 领取同一条记录，领到后放回本页输入框。
import { api, ApiError, newId } from "./api.ts";
import { normalize } from "./draft.ts";
import type { RestoredDraft } from "./restored.ts";
import { Store } from "./store.ts";
import type { PaneClaimResult, PaneSavedDrafts, PaneSavedDraftsList } from "./types.ts";

/** 各会话最近一次读到的未领取记录。 */
export const savedDrafts = new Store<ReadonlyMap<string, readonly PaneSavedDrafts[]>>(new Map());
/** 本页面正在等待停止或关闭结果的 requestId。结果到达后由本页面领取，等待期间不在待取回条中显示，避免同一条出现在本页的两处。 */
export const awaiting = new Store<ReadonlySet<string>>(new Set());
/** 本页面正在领取（放回或放弃）的记录，键为 claimKey。只禁用这些记录的按钮，其他记录和其他会话不受影响。 */
export const claiming = new Store<ReadonlySet<string>>(new Set());
export const claimKey = (sessionId: string, recordId: string) => JSON.stringify([sessionId, recordId]);
/** 每个会话的读取代次：只采用最后一次发起的读取，乱序到达的旧列表丢弃。 */
const reads = new Map<string, number>();
/** 领取的总期限：包括进行中的请求、网络中断时的重试和服务端仍在执行（pending）时的轮询，与控制命令的网络重试期限相同。 */
export const CLAIM_RETRY_MS = 120_000;
/**
 * 本页面对各记录领取用的 requestId，键为 claimKey。领取超过期限放弃后，服务端可能随后才完成领取，结果只能用原 requestId 取到，
 * 因此同一记录的再次领取沿用原 requestId，直到领到内容或得到 gone。
 */
const claimIds = new Map<string, string>();

const draftsPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/drafts`;

/** 重新读取该会话的未领取记录。读取失败时保留已显示的列表，下次打开会话、重新连接或收到变更通知时再读取。 */
export async function refreshSaved(sessionId: string): Promise<void> {
  const seq = (reads.get(sessionId) ?? 0) + 1; reads.set(sessionId, seq);
  let records: PaneSavedDrafts[];
  try { records = (await api<PaneSavedDraftsList>(draftsPath(sessionId))).records; } catch { return; }
  if (reads.get(sessionId) !== seq) return;
  savedDrafts.set((all) => new Map(all).set(sessionId, records));
}

/** 待取回条显示的记录：去掉本页面正在等待结果、将按同步路径领取的记录。 */
export function visibleSaved(all: ReadonlyMap<string, readonly PaneSavedDrafts[]>, waiting: ReadonlySet<string>, sessionId: string): PaneSavedDrafts[] {
  return (all.get(sessionId) ?? []).filter((record) => !waiting.has(record.id));
}

/** 记录中的草稿，按保存时的顺序：确定的在前，归属不明的在后。 */
export function recordDrafts(record: PaneSavedDrafts): RestoredDraft[] {
  return record.drafts.map((draft) => ({ nodes: normalize(draft.nodes), uncertain: draft.uncertain === true }));
}

/** claimSaved 的计时，测试可替换。 */
export interface ClaimClock { sleep: (ms: number, signal: AbortSignal) => Promise<void>; limit: number }
const realClock: ClaimClock = {
  limit: CLAIM_RETRY_MS,
  sleep: (ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }),
};

/**
 * 领取一条记录，返回其内容；记录已被其他页面领取、已过期或不存在时返回 null。
 * 领取会删除服务端记录：网络中断或服务端仍在执行（pending）时用同一 requestId 重试，由服务端幂等记录返回同一份内容。
 * 整个领取有一个总期限（clock.limit），到期时中止进行中的请求，不再发出新请求，抛出 ApiError（claimTimeout）；其他失败抛出原 ApiError。
 * 领取期间该记录登记在 claiming 中。结束后重新读取该会话的列表。
 */
export async function claimSaved(sessionId: string, recordId: string, clock: Partial<ClaimClock> = {}): Promise<PaneSavedDrafts | null> {
  const { sleep, limit } = { ...realClock, ...clock };
  const key = claimKey(sessionId, recordId);
  const requestId = claimIds.get(key) ?? newId(); claimIds.set(key, requestId);
  const body = { requestId };
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), limit);
  const giveUp = Date.now() + limit; let delay = 500;
  const expired = () => new ApiError(0, "claimTimeout", "领取没有在期限内完成，请稍后在待取回列表中重试");
  /** 剩余时间内等待 ms 毫秒；返回是否仍在期限内。 */
  const wait = async (ms: number) => {
    const left = giveUp - Date.now();
    if (left <= 0 || deadline.signal.aborted) return false;
    await sleep(Math.min(ms, left), deadline.signal);
    return Date.now() < giveUp && !deadline.signal.aborted;
  };
  claiming.set((set) => new Set(set).add(key));
  try {
    for (;;) {
      if (Date.now() >= giveUp || deadline.signal.aborted) throw expired();
      let result: PaneClaimResult | { status: "pending" };
      try { result = await api<PaneClaimResult | { status: "pending" }>(`${draftsPath(sessionId)}/${encodeURIComponent(recordId)}/claim`, body, deadline.signal); }
      catch (error) {
        if (deadline.signal.aborted) throw expired();
        if (!(error instanceof ApiError && (error.code === "network" || error.code === "invalidResponse"))) throw error;
        if (!await wait(delay)) throw expired();
        delay = Math.min(5000, delay * 2);
        continue;
      }
      if (result.status === "pending") { if (!await wait(1000)) throw expired(); continue; }
      claimIds.delete(key);
      // 记录已不在服务端：立即从本页列表中去掉，不等重新读取。
      savedDrafts.set((all) => new Map(all).set(sessionId, (all.get(sessionId) ?? []).filter((record) => record.id !== recordId)));
      return result.status === "claimed" ? result.record : null;
    }
  } finally {
    clearTimeout(timer);
    claiming.set((set) => { const next = new Set(set); next.delete(key); return next; });
    void refreshSaved(sessionId);
  }
}

/** takeSaved 依赖的界面操作，由待取回条传入。 */
export interface TakeDeps {
  /** 当前导航代次（session.ts 的 navigation）。 */
  navigation: () => number;
  ask: (title: string, message: string, choices: { label: string; value: string; danger?: boolean }[]) => Promise<string | null>;
  toast: (message: string, level?: "warning" | "error") => void;
  /** 把领取到的草稿交给该会话的输入框（restored.ts 的 deliverRestored）。 */
  deliver: (sessionId: string, drafts: RestoredDraft[]) => void;
}

/**
 * 待取回条中的“放回输入框”（discard 为 false）和“放弃”。操作属于发起时的会话：放弃的确认期间切换了会话就不再执行；
 * 结果迟到时，提示只在仍停留在原会话时显示，放回的草稿交给原会话（deliver 按“取回草稿的交付”处理）。
 */
export async function takeSaved(sessionId: string, record: PaneSavedDrafts, discard: boolean, deps: TakeDeps): Promise<"restored" | "discarded" | "gone" | "cancelled" | "navigated" | "failed"> {
  const owner = deps.navigation(); const here = () => deps.navigation() === owner;
  if (discard && await deps.ask("放弃排队的消息", "放弃后这些消息无法恢复。", [{ label: "取消", value: "cancel" }, { label: "放弃", value: "ok", danger: true }]) !== "ok") return "cancelled";
  if (!here()) return "navigated";
  let claimed: PaneSavedDrafts | null;
  try { claimed = await claimSaved(sessionId, record.id); }
  catch (error) { if (here()) deps.toast((error as Error).message, "error"); return "failed"; }
  if (!claimed) { if (here()) deps.toast("这些消息已在其他页面放回或放弃", "warning"); return "gone"; }
  if (discard) { if (here()) deps.toast("已放弃"); return "discarded"; }
  // 领取后即为普通的输入框内容：放在现有内容之前并立即保存；切换了会话时进入该会话的待放回记录。
  deps.deliver(sessionId, recordDrafts(claimed));
  return "restored";
}

/** 本页面发出停止或关闭请求，等待结果期间记下 requestId；返回结束等待的函数。 */
export function awaitSaved(requestId: string): () => void {
  awaiting.set((set) => new Set(set).add(requestId));
  return () => awaiting.set((set) => { const next = new Set(set); next.delete(requestId); return next; });
}
