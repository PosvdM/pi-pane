// 停止或关闭时清出的排队草稿（architecture.md“停止与控制队列”）：一律放回所属会话的输入框，不经确认框。
// 该会话的输入框已挂载时直接放回；未挂载（已切换会话、正在加载、已回到配对页）时存入 localStorage，
// 输入框挂载时取走。待放回的草稿与输入框草稿分开保存，其他标签页保存同一会话的输入框内容时不会覆盖它。
// 纯逻辑，Storage 由调用方传入，可在 Node.js 中测试。
import { isEmpty } from "./draft.ts";
import type { DraftNode } from "./types.ts";

/** drafts 中排在最后的 uncertain 条是扩展改写后归属不明、可能已经发送的草稿。 */
export interface RestoredDrafts { drafts: DraftNode[][]; uncertain: number }
/** 输入框接收草稿的回调；必须在返回前把输入框内容写入 localStorage，之后才删除待放回记录。 */
export type DraftSink = (restored: RestoredDrafts) => void;

export const pendingKey = (sessionId: string) => `pi-pane.restored.${sessionId}`;
const sinks = new Map<string, DraftSink>();

export function readPending(storage: Storage, sessionId: string): RestoredDrafts | null {
  try {
    const value = JSON.parse(storage.getItem(pendingKey(sessionId)) ?? "null");
    if (value && Array.isArray(value.drafts) && value.drafts.every(Array.isArray)) return { drafts: value.drafts, uncertain: Number(value.uncertain) || 0 };
  } catch { /* 记录损坏时按没有待放回草稿处理。 */ }
  return null;
}

/**
 * 把一次停止或关闭清出的草稿交给 sessionId 的输入框。返回 composer：已放进本标签页挂载的输入框；
 * stored：已存入待放回记录；none：没有非空草稿。
 */
export function deliverRestored(storage: Storage, sessionId: string, restored: RestoredDrafts): "composer" | "stored" | "none" {
  const drafts = restored.drafts.filter((draft) => !isEmpty(draft));
  if (!drafts.length) return "none";
  const uncertain = Math.min(restored.uncertain, drafts.length);
  const sink = sinks.get(sessionId);
  if (sink) { sink({ drafts, uncertain }); return "composer"; }
  // 后清出的批次排在前面，与输入框挂载时逐批放到现有草稿之前的结果一致。
  const pending = readPending(storage, sessionId);
  storage.setItem(pendingKey(sessionId), JSON.stringify(pending ? { drafts: [...drafts, ...pending.drafts], uncertain: uncertain + pending.uncertain } : { drafts, uncertain }));
  return "stored";
}

/** 把已保存的待放回草稿交给输入框，输入框写入后删除记录；写入抛错时保留记录。 */
export function takePending(storage: Storage, sessionId: string, sink: DraftSink): boolean {
  const pending = readPending(storage, sessionId);
  if (!pending) { storage.removeItem(pendingKey(sessionId)); return false; }
  sink(pending);
  storage.removeItem(pendingKey(sessionId));
  return true;
}

/** 输入框挂载时登记并取走已保存的待放回草稿；返回注销函数。 */
export function attachComposer(storage: Storage, sessionId: string, sink: DraftSink): () => void {
  sinks.set(sessionId, sink);
  takePending(storage, sessionId, sink);
  return () => { if (sinks.get(sessionId) === sink) sinks.delete(sessionId); };
}
