// pi steer/follow-up 队列的镜像：把实际队列项与 pane 发送时的原草稿（含图片节点）关联。
// pi 的 queue_update 只带文字，clear_queue 也只返回文字；技能、提示模板和扩展输入处理器会在入队前改写文字，
// 所以不能靠文字找回草稿，只能按队列项的身份跟踪：新项追加在队尾，开始处理的用户消息删除第一条文字相同的项。
import type { DraftNode } from "@pi-pane/plugin-api";

export type QueueKind = "steering" | "followUp";
export interface QueueItem { text: string; draft?: DraftNode[]; key?: string }
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

/** 本次请求期间新增的项中最后一项属于这次输入（扩展输入处理器追加的消息先于当前输入入队）。 */
export function claim(before: readonly QueueItem[], after: readonly QueueItem[], draft: DraftNode[], key?: string): boolean {
  const known = new Set(before);
  const fresh = after.filter((item) => !known.has(item) && !item.draft);
  const target = fresh.at(-1);
  if (!target) return false;
  target.draft = structuredClone(draft); target.key = key;
  return true;
}

/**
 * clear_queue 之前的镜像与清出的文字对应：两次读取之间只可能有队首项被消费，清出的文字是镜像的后缀。
 * 返回与 texts 等长的数组，无法确认对应关系的位置为 undefined。
 */
export function match(snapshot: readonly QueueItem[], texts: readonly string[]): (QueueItem | undefined)[] {
  const offset = snapshot.length - texts.length;
  return texts.map((text, i) => {
    const item = offset >= 0 ? snapshot[offset + i] : undefined;
    return item && item.text === text ? item : undefined;
  });
}
