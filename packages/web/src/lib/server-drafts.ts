// 停止、关闭结果的续取与服务端保存的清出草稿的取回（architecture.md“服务端暂存的清出草稿”）。
// 发起停止或关闭的页面得到结果后放回草稿并请服务端删除记录；结果没有交到该页面时（页面刷新或关闭、断网超过重试期限），
// 之后的页面用同一 requestId 续取结果，服务端重启后幂等记录已不在时按 requestId 读取服务端保存的记录。
// 服务端关停或写者停止时清出的草稿没有发起请求的页面，打开该会话时取回。
// 纯逻辑，Storage、Web Locks 和 HTTP 调用由调用方传入，可在 Node.js 中测试。
import { normalize } from "./draft.ts";
import {
  FLIGHT_GRACE_MS, FLIGHT_HELD_RECHECK_MS, FLIGHT_STALE_MS, clearAck, deferredIds, encodeId, isLive, pendingAcks, settleServerDrafts, stopFlights,
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
/** 续取时服务端返回 pending（停止仍在执行）的重查间隔，删除记录返回 pending 时同样适用。 */
export const PENDING_RECHECK_MS = 1_000;
/**
 * 在途请求只在发起后这段时间内用原请求体重新提交。服务端幂等记录在请求结束后至少保留 24 小时，这段时间内重新提交只会取回原结果；
 * 超过后幂等记录可能已过期，重新提交会再执行一次，因此只按 requestId 读取服务端保存的记录。留 1 小时余量。
 */
export const REPLAY_MS = 23 * 3_600_000;

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

const statusOf = (error: unknown) => (error as { status?: number }).status ?? 0;
const codeOf = (error: unknown) => (error as { code?: string }).code ?? "";
/** 读取或删除服务端记录时，稍后重试即可能成功的失败：网络中断、响应无法解析、需要重新配对、服务端内部错误或正在关闭、请求过多。 */
function transient(error: unknown): boolean {
  const status = statusOf(error); const code = codeOf(error);
  return status === 0 || status >= 500 || status === 401 || status === 429 || code === "network" || code === "invalidResponse";
}
/**
 * 重新提交停止或关闭时，请求没有到达幂等记录的失败：网络中断、响应无法解析、服务端正在关闭、请求过多（401 另行处理）。
 * 其他失败都来自幂等记录，是这次请求的最终结果，包括缓存的服务端内部错误（例如清队列并保存后停止进程失败）。
 */
function replayUnreached(error: unknown): boolean {
  const status = statusOf(error); const code = codeOf(error);
  return status === 0 || status === 429 || code === "serverStopping" || code === "network" || code === "invalidResponse";
}

const draftsPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/drafts`;

/** 下一次续取：delay 毫秒后执行；saved 为 true 时还要读取服务端保存的记录。 */
export interface RecoveryNext { delay: number; saved: boolean }

/**
 * 续取并放回该会话的服务端草稿，在标签页之间用 Web Lock 串行。依次：
 * 1. 请服务端删除已放回的记录；
 * 2. 续取已无页面等待的停止、关闭在途请求：在 REPLAY_MS 内且请求未确定结束时用原请求体重新提交，得到结果后放回；
 *    请求已确定结束而没有结果时（被拒绝、服务端重启后幂等记录已不在、缓存了失败），或超过 REPLAY_MS，按 requestId 读取服务端保存的记录；
 * 3. saved 为 true 时读取服务端保存的其他记录并放回：跳过本浏览器仍有在途请求或待删除登记、以及本页面暂不删除的记录，
 *    由停止或关闭请求产生的记录超过 ORPHAN_MS 才取回，未到期时安排到期后再读。
 * 返回下一次续取的时间和是否需要再读取记录，没有则为 null。需要重新配对时返回 null，连接建立后由调用方重新续取。
 */
export async function recoverServerDrafts(deps: ServerDraftsDeps, sessionId: string, saved: boolean): Promise<RecoveryNext | null> {
  const run = () => recoverLocked(deps, sessionId, saved);
  return deps.locks ? deps.locks.request(`pi-pane.serverdrafts.${encodeId(sessionId)}`, run) : run();
}

async function recoverLocked(deps: ServerDraftsDeps, sessionId: string, saved: boolean): Promise<RecoveryNext | null> {
  const { storage, locks, call } = deps; const now = deps.now ?? Date.now;
  let next: RecoveryNext | null = null; let unauthorized = false;
  const later = (ms: number, list = false) => { next = { delay: Math.min(next?.delay ?? ms, ms), saved: (next?.saved ?? false) || list }; };
  const unavailable = (error: unknown, list = false) => { if (statusOf(error) === 401) unauthorized = true; else later(UNAVAILABLE_RECHECK_MS, list); };

  const acknowledge = async () => {
    for (const { key, ids } of pendingAcks(storage, sessionId)) {
      let result: { status?: string } | undefined;
      try { result = await call<{ status?: string }>(draftsPath(sessionId), { requestId: deps.newId(), remove: ids }); }
      catch (error) {
        if (transient(error)) { unavailable(error); return; }
        // 请求被拒绝时重试也不会成功；记录留在服务端，到期后由服务端清理。
        clearAck(storage, sessionId, key); continue;
      }
      // 删除超过服务端的等待期限时返回 pending，记录可能仍在：保留登记，稍后再删一次（删除不存在的记录也成功）。
      if (result?.status === "pending") { later(PENDING_RECHECK_MS); return; }
      clearAck(storage, sessionId, key);
    }
  };
  let records: PaneSavedDrafts[] | undefined;
  const list = async () => records ??= (await call<PaneSavedDraftsList>(draftsPath(sessionId))).records;

  const resume = async (flight: StopFlight) => {
    // 等待锁期间记录可能已被其他页面取走。
    if (!stopFlights(storage, sessionId).some((item) => item.key === flight.key)) return;
    if (!flight.final && now() - flight.at < REPLAY_MS) {
      let result: PaneControlResult | undefined;
      try { result = await call<PaneControlResult>(`/api/sessions/${encodeURIComponent(sessionId)}/control`, flight.body); }
      catch (error) {
        if (statusOf(error) === 401) { unauthorized = true; return; }
        if (replayUnreached(error)) { later(UNAVAILABLE_RECHECK_MS); return; }
      }
      if (result?.status === "pending") { later(PENDING_RECHECK_MS); return; }
      if (result) {
        const drafts = result.status === "done" ? clearedDrafts(result) : [];
        settleServerDrafts(storage, sessionId, drafts.length ? [flight.body.requestId] : [], drafts, RESTORED_MESSAGE.stop, flight.key);
        return;
      }
    }
    let record: PaneSavedDrafts | undefined;
    try { record = (await list()).find((item) => item.id === flight.body.requestId); }
    catch (error) { unavailable(error); return; }
    settleServerDrafts(storage, sessionId, record ? [record.id] : [], record ? savedDrafts(record) : [], record ? RESTORED_MESSAGE[record.reason] : null, flight.key);
  };

  await acknowledge();
  for (const flight of stopFlights(storage, sessionId)) {
    if (isLive(flight.key)) continue;
    // 已确定结束的请求不再重新提交，没有其他页面需要等待，不设保护期。
    const wait = flight.final ? 0 : (locks ? FLIGHT_GRACE_MS : FLIGHT_STALE_MS) - (now() - flight.at);
    if (wait > 0) { later(wait); continue; }
    // 持有该记录的锁时续取。发起的页面仍在等待、或刷新时旧页面尚未释放锁时拿不到锁，稍后重查。
    if (locks) await locks.request(flight.key, { ifAvailable: true }, async (lock) => { if (lock) await resume(flight); else later(FLIGHT_HELD_RECHECK_MS); });
    else await resume(flight);
  }
  if (saved) {
    try {
      const skip = new Set([
        ...stopFlights(storage, sessionId).map((flight) => flight.body.requestId),
        ...pendingAcks(storage, sessionId).flatMap((ack) => ack.ids),
        ...deferredIds(sessionId),
      ]);
      for (const record of await list()) {
        if (skip.has(record.id)) continue;
        if (record.reason === "stop" || record.reason === "close") {
          const age = now() - Date.parse(record.at);
          if (age < ORPHAN_MS) { later(ORPHAN_MS - age, true); continue; }
        }
        settleServerDrafts(storage, sessionId, [record.id], savedDrafts(record), RESTORED_MESSAGE[record.reason]);
      }
    } catch (error) { if (transient(error)) unavailable(error, true); }
  }
  await acknowledge();
  return unauthorized ? null : next;
}
