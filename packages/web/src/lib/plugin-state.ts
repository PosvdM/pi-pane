// 插件界面的纯逻辑：通知保留、横幅折叠、输入框文字放回。不依赖 DOM 和网络，测试直接在 Node.js 中运行。
import type { BannerState, PaneNotification } from "./types.ts";

/** 自动消失的通知最多同时显示的条数；error 和 sticky 需要用户手动关闭，不计入、也不会被挤掉。 */
export const TRANSIENT_LIMIT = 5;
/** 非 sticky 通知的停留时间：info 5 秒，warning 8 秒（与普通提示相同）。 */
export const NOTIFY_MS: Record<"info" | "warning", number> = { info: 5000, warning: 8000 };

export const manualClose = (n: Pick<PaneNotification, "level" | "sticky">) => n.level === "error" || !!n.sticky;

/** 加入一条通知：同 (source, id) 只显示一次；自动消失的通知超过上限时移除最早的，手动关闭的始终保留。 */
export function addNotificationTo(list: PaneNotification[], notification: PaneNotification): PaneNotification[] {
  if (list.some((n) => n.source === notification.source && n.id === notification.id)) return list;
  const next = [...list, notification];
  let transient = next.filter((n) => !manualClose(n)).length;
  return next.filter((n) => manualClose(n) || transient-- <= TRANSIENT_LIMIT);
}

const LEVEL: Record<BannerState["level"], number> = { error: 0, warning: 1, info: 2 };
/** 横幅按级别（error 在前）排列，同级保持服务端给出的顺序（即设置时间）。 */
export function sortBanners(list: BannerState[]): BannerState[] {
  return list.map((b, i) => ({ b, i })).sort((x, y) => LEVEL[x.b.level] - LEVEL[y.b.level] || x.i - y.i).map((x) => x.b);
}
/** 超过 3 条且没有展开全部时，只显示前 2 条，其余合并为一行“另有 N 条横幅”。 */
export function visibleBanners(sorted: BannerState[], showAll: boolean): { shown: BannerState[]; folded: number } {
  if (showAll || sorted.length <= 3) return { shown: sorted, folded: 0 };
  return { shown: sorted.slice(0, 2), folded: sorted.length - 2 };
}

/** 提交失败后把文字放回输入框：放在等待期间新写的内容之前。 */
export function restoreText(submitted: string, current: string): string {
  return [submitted, current].filter((value) => value.trim()).join("\n");
}

/** 标题栏最多显示 3 个动作，其余放进“⋯”菜单。 */
export const HEAD_ACTIONS = 3;
export function splitActions<T>(actions: T[]): { shown: T[]; more: T[] } {
  return { shown: actions.slice(0, HEAD_ACTIONS), more: actions.slice(HEAD_ACTIONS) };
}

/** 侧栏宽度的范围与默认值（px）。 */
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 280;
export function clampSidebar(value: number): number {
  return Number.isFinite(value) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value))) : SIDEBAR_DEFAULT;
}
