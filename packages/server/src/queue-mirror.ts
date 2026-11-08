// pi steer/follow-up 队列的镜像：把实际队列项与 pane 发送时的原草稿（含图片节点）关联。
// pi 的 queue_update 只带文字，clear_queue 也只返回文字；技能、提示模板和扩展输入处理器会在入队前改写文字，
// 所以不能只靠文字找回草稿，而是按队列项的身份跟踪：新项追加在队尾，开始处理的用户消息删除第一条文字相同的项。
import type { DraftNode } from "@pi-pane/plugin-api";

export type QueueKind = "steering" | "followUp";
/** 同一次请求无法确定归属时，候选项共享一个分组；只有全部候选都仍在队列中时才取回该草稿。 */
export interface DraftClaim { draft: DraftNode[]; key?: string; candidates: number }
export interface QueueItem { text: string; claim?: DraftClaim }
export type QueueMirror = Record<QueueKind, QueueItem[]>;

export const emptyMirror = (): QueueMirror => ({ steering: [], followUp: [] });

/**
 * 按 pi 的规则把镜像对齐到新的队列文字：删除的是同文字的最早项，新增项在队尾。
 * 从右向左匹配保留较晚的同文字项；无法匹配的尾部文字视为新增项。
 */
export function reconcile(items: readonly QueueItem[], texts: readonly string[]): QueueItem[] {
  for (let appended = 0; appended <= texts.length; appended++) {
    const base = texts.slice(0, texts.length - appended);
    const kept: QueueItem[] = []; let i = items.length - 1;
    for (let j = base.length - 1; j >= 0; j--) {
      while (i >= 0 && items[i].text !== base[j]) i--;
      if (i < 0) break;
      kept.unshift(items[i--]);
    }
    if (kept.length === base.length) return [...kept, ...texts.slice(texts.length - appended).map((text) => ({ text }))];
  }
  return texts.map((text) => ({ text }));
}

const nonceOf = (text: string) => /⟦pane-img:([a-z0-9]{6,8}):\d+⟧/.exec(text)?.[1];

/**
 * 为一次已入队（disposition 为 queued）的请求认领队列项。请求期间扩展也可能入队，且异步处理的先后不确定：
 * 文字等于发送文字或带有同一图片标记的唯一新增项直接认领；只有一个新增项时认领它；
 * 其余情况把全部新增项作为同一分组的候选，停止时只有全部候选都还在队列中才取回草稿。
 */
export function claim(before: readonly QueueItem[], after: readonly QueueItem[], draft: DraftNode[], key?: string): boolean {
  const known = new Set(before);
  const fresh = after.filter((item) => !known.has(item) && !item.claim);
  if (!fresh.length) return false;
  const nonce = key ? nonceOf(key) : undefined;
  const exact = fresh.filter((item) => item.text === key || (nonce !== undefined && nonceOf(item.text) === nonce));
  const targets = exact.length === 1 ? exact : fresh;
  const shared: DraftClaim = { draft: structuredClone(draft), key, candidates: targets.length };
  for (const item of targets) item.claim = shared;
  return true;
}

/**
 * clear_queue 之前的镜像与清出的文字对应：两次读取之间只可能有队首项被消费，清出的文字是镜像的后缀。
 * 返回与 texts 等长的归属确定的草稿（无法确认的位置为 undefined），以及归属不明、至少有一个候选被清出的分组草稿。
 * 分组草稿可能已发送，也可能仍在队列中，由用户确认是否放回，既不自动占用某个候选的位置，也不丢弃。
 */
export function restore(snapshot: readonly QueueItem[], texts: readonly string[]): { certain: (DraftClaim | undefined)[]; uncertain: DraftClaim[] } {
  const offset = snapshot.length - texts.length;
  const items = texts.map((text, i) => {
    const item = offset >= 0 ? snapshot[offset + i] : undefined;
    return item && item.text === text ? item : undefined;
  });
  const certain = items.map((item) => item?.claim && item.claim.candidates === 1 ? item.claim : undefined);
  const uncertain = [...new Set(items.flatMap((item) => item?.claim && item.claim.candidates > 1 ? [item.claim] : []))];
  return { certain, uncertain };
}

/** 对齐后被移除（已消费或已清出）的项。 */
export function removed(before: readonly QueueItem[], after: readonly QueueItem[]): QueueItem[] {
  const kept = new Set(after);
  return before.filter((item) => !kept.has(item));
}
