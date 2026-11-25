// 停止、关闭结果的续取与服务端保存的清出草稿的取回（architecture.md“服务端暂存的清出草稿”）。
// 发起停止或关闭的页面得到结果后放回草稿并请服务端删除记录；结果没有交到该页面时（页面刷新或关闭、断网超过重试期限），
// 之后的页面用同一 requestId 续取结果，服务端重启后幂等记录已不在时按 requestId 读取服务端保存的记录。
// 服务端关停或写者停止时清出的草稿没有发起请求的页面，打开该会话时取回。
// 纯逻辑，Storage、Web Locks 和 HTTP 调用由调用方传入，可在 Node.js 中测试。
import { normalize } from "./draft.ts";
import {
  FLIGHT_GRACE_MS, FLIGHT_HELD_RECHECK_MS, FLIGHT_STALE_MS, clearAck, encodeId, isLive, pendingAcks, settleServerDrafts, stopFlights,
  type RestoredDraft, type StopFlight,
} from "./restored.ts";
import type { PaneControlResult, PaneSavedDrafts, PaneSavedDraftsList } from "./types.ts";

type Locks = Pick<LockManager, "request">;
export interface ServerDraftsDeps {
  storage: Storage;
  locks: Locks | null;
  /** HTTP 调用；失败时抛出带 status、code 的错误（ApiError），网络错误的 status 为 0。 */
  call: <T>(path: string, body?: unknown) => Promise<T>;
  newId: () => string;
  now?: () => number;
}

/** 由停止或关闭请求产生、但本浏览器没有对应在途请求的记录，超过此时长后才取回：发起请求的可能是另一浏览器中仍在等待结果的页面。 */
export const ORPHAN_MS = 10 * 60_000;
/** 网络或服务端暂时不可用时的重查间隔。 */
export const UNAVAILABLE_RECHECK_MS = 5_000;
/** 续取时服务端返回 pending（停止仍在执行）的重查间隔。 */
export const PENDING_RECHECK_MS = 1_000;

export const RESTORED_MESSAGE: Record<PaneSavedDrafts["reason"], string> = {
  stop: "排队中的消息已放回输入框",
  close: "排队中的消息已放回输入框",
  shutdown: "服务端关闭前排队的消息已放回输入框",
  exit: "会话停止时排队的消息已放回输入框",
};

/** 停止或关闭结果中的草稿：确定的在前，归属不明的在后。 */
export function clearedDrafts(result: { clearedDrafts: PaneSavedDrafts["drafts"][number]["nodes"][]; uncertainDrafts?: PaneSavedDrafts["drafts"][number]["nodes"][] }): RestoredDraft[] {
  return [
    ...result.clearedDrafts.map((nodes) => ({ nodes: normalize(nodes), uncertain: false })),
    ...(result.uncertainDrafts ?? []).map((nodes) => ({ nodes: normalize(nodes), uncertain: true })),
  ];
}
const savedDrafts = (record: PaneSavedDrafts): RestoredDraft[] => record.drafts.map((draft) => ({ nodes: normalize(draft.nodes), uncertain: draft.uncertain === true }));

/** 稍后重试即可能成功的失败：网络中断、响应无法解析、需要重新配对、服务端内部错误或正在关闭、请求过多。 */
function transient(error: unknown): boolean {
  const { status = 0, code = "" } = error as { status?: number; code?: string };
  return status === 0 || status >= 500 || status === 401 || status === 429 || code === "network" || code === "invalidResponse";
}

const draftsPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/drafts`;

/**
 * 续取并放回该会话的服务端草稿，在标签页之间用 Web Lock 串行。依次：
 * 1. 请服务端删除已放回的记录；
 * 2. 续取已无页面等待的停止、关闭在途请求：用原请求体重新提交，得到结果后放回；请求已确定结束而没有结果时
 *    （服务端重启后幂等记录已不在，或请求被拒绝），按 requestId 读取服务端保存的记录；
 * 3. saved 为 true 时读取服务端保存的其他记录并放回：跳过本浏览器仍有在途请求或待删除登记的记录，
 *    由停止或关闭请求产生的记录超过 ORPHAN_MS 才取回。
 * 返回还需多少毫秒后再检查，没有则为 null。
 */
export async function recoverServerDrafts(deps: ServerDraftsDeps, sessionId: string, saved: boolean): Promise<number | null> {
  const run = () => recoverLocked(deps, sessionId, saved);
  return deps.locks ? deps.locks.request(`pi-pane.serverdrafts.${encodeId(sessionId)}`, run) : run();
}

async function recoverLocked(deps: ServerDraftsDeps, sessionId: string, saved: boolean): Promise<number | null> {
  const { storage, locks, call } = deps; const now = deps.now ?? Date.now;
  let recheck: number | null = null; let unauthorized = false;
  const later = (ms: number) => { recheck = Math.min(recheck ?? ms, ms); };
  // 需要重新配对时不再定时重试，配对后连接建立时重新续取（session.ts 的 recoverAllDrafts）。
  const unavailable = (error: unknown) => { if ((error as { status?: number }).status === 401) unauthorized = true; else later(UNAVAILABLE_RECHECK_MS); };

  const acknowledge = async () => {
    for (const { key, ids } of pendingAcks(storage, sessionId)) {
      try { await call(draftsPath(sessionId), { requestId: deps.newId(), remove: ids }); clearAck(storage, sessionId, key); }
      catch (error) {
        if (transient(error)) { unavailable(error); return; }
        // 请求被拒绝时重试也不会成功；记录留在服务端，到期后由服务端清理。
        clearAck(storage, sessionId, key);
      }
    }
  };
  let records: PaneSavedDrafts[] | undefined;
  const list = async () => records ??= (await call<PaneSavedDraftsList>(draftsPath(sessionId))).records;

  const resume = async (flight: StopFlight) => {
    // 等待锁期间记录可能已被其他页面取走。
    if (!stopFlights(storage, sessionId).some((item) => item.key === flight.key)) return;
    let result: PaneControlResult;
    try { result = await call<PaneControlResult>(`/api/sessions/${encodeURIComponent(sessionId)}/control`, flight.body); }
    catch (error) {
      if (transient(error)) { unavailable(error); return; }
      let record: PaneSavedDrafts | undefined;
      try { record = (await list()).find((item) => item.id === flight.body.requestId); }
      catch (error) { unavailable(error); return; }
      settleServerDrafts(storage, sessionId, record ? [record.id] : [], record ? savedDrafts(record) : [], record ? RESTORED_MESSAGE[record.reason] : null, flight.key);
      return;
    }
    if (result.status === "pending") { later(PENDING_RECHECK_MS); return; }
    const drafts = result.status === "done" ? clearedDrafts(result) : [];
    settleServerDrafts(storage, sessionId, drafts.length ? [flight.body.requestId] : [], drafts, RESTORED_MESSAGE.stop, flight.key);
  };

  await acknowledge();
  const flights = stopFlights(storage, sessionId);
  for (const flight of flights) {
    if (isLive(flight.key)) continue;
    const wait = (locks ? FLIGHT_GRACE_MS : FLIGHT_STALE_MS) - (now() - flight.at);
    if (wait > 0) { later(wait); continue; }
    // 持有该记录的锁时续取。发起的页面仍在等待、或刷新时旧页面尚未释放锁时拿不到锁，稍后重查。
    if (locks) await locks.request(flight.key, { ifAvailable: true }, async (lock) => { if (lock) await resume(flight); else later(FLIGHT_HELD_RECHECK_MS); });
    else await resume(flight);
  }
  if (saved) {
    try {
      const skip = new Set([...stopFlights(storage, sessionId).map((flight) => flight.body.requestId), ...pendingAcks(storage, sessionId).flatMap((ack) => ack.ids)]);
      for (const record of await list()) {
        if (skip.has(record.id)) continue;
        if ((record.reason === "stop" || record.reason === "close") && now() - Date.parse(record.at) < ORPHAN_MS) continue;
        settleServerDrafts(storage, sessionId, [record.id], savedDrafts(record), RESTORED_MESSAGE[record.reason]);
      }
    } catch (error) { if (transient(error)) unavailable(error); }
  }
  await acknowledge();
  return unauthorized ? null : recheck;
}
