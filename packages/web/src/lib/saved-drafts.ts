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
/** 每个会话的读取代次：只采用最后一次发起的读取，乱序到达的旧列表丢弃。 */
const reads = new Map<string, number>();
/** 领取时网络中断的重试期限，与控制命令的网络重试期限相同。 */
const CLAIM_RETRY_MS = 120_000;

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

/**
 * 领取一条记录，返回其内容；记录已被其他页面领取、已过期或不存在时返回 null。
 * 领取会删除服务端记录：网络中断时在 CLAIM_RETRY_MS 内用同一 requestId 重试，由服务端幂等记录返回同一份内容。
 * 其他失败抛出 ApiError。结束后重新读取该会话的列表。
 */
export async function claimSaved(sessionId: string, recordId: string): Promise<PaneSavedDrafts | null> {
  const body = { requestId: newId() }; const giveUp = Date.now() + CLAIM_RETRY_MS; let delay = 500;
  try {
    for (;;) {
      let result: PaneClaimResult | { status: "pending" };
      try { result = await api<PaneClaimResult | { status: "pending" }>(`${draftsPath(sessionId)}/${encodeURIComponent(recordId)}/claim`, body); }
      catch (error) {
        if (!(error instanceof ApiError && (error.code === "network" || error.code === "invalidResponse")) || Date.now() > giveUp) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay)); delay = Math.min(5000, delay * 2);
        continue;
      }
      if (result.status === "pending") { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
      // 记录已不在服务端：立即从本页列表中去掉，不等重新读取。
      savedDrafts.set((all) => new Map(all).set(sessionId, (all.get(sessionId) ?? []).filter((record) => record.id !== recordId)));
      return result.status === "claimed" ? result.record : null;
    }
  } finally { void refreshSaved(sessionId); }
}

/** 本页面发出停止或关闭请求，等待结果期间记下 requestId；返回结束等待的函数。 */
export function awaitSaved(requestId: string): () => void {
  awaiting.set((set) => new Set(set).add(requestId));
  return () => awaiting.set((set) => { const next = new Set(set); next.delete(requestId); return next; });
}
