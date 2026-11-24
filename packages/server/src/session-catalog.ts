import type { MainSessionInfo, NodeStatus } from "@pi-pane/plugin-api";
import { firstUserText, normalizeSessionName, sessionTitle } from "./session-title.js";
import type { Entry } from "./store.js";
import type { MainTreeRow } from "./plugins/main-tree.js";

/** 存储目录中的一个会话：PiStore.list 的一行，名称已归一化，首条文本已消除 pi 占位值的歧义。 */
export interface StoredSession {
  id: string; file: string; cwd: string; name?: string; firstText: string;
  created: Date; modified: Date; messageCount: number; parentSessionFile?: string;
}

/** 已在服务端登记的会话的实时状态。name 为 undefined 表示尚未读到名称，此时名称和首条文本沿用存储目录。 */
export interface LiveSession {
  file: string; cwd: string; name?: { value: string | undefined }; entries: readonly Entry[]; lastActive: number;
  hosted: boolean; status: NodeStatus; holds: { source: string; reason: string }[];
}

/**
 * 会话目录的一项：存储目录的一行叠加登记会话的实时状态。前端会话列表（PaneSessionList）与
 * 插件协议的主会话（MainSessionInfo、主会话树）都由它投影，两处的名称、首条文本、消息数、托管与状态取值相同。
 */
export interface CatalogEntry {
  id: string; file: string; cwd: string;
  name?: string;                 // 归一化后的会话名称
  firstText: string;             // 首条用户文本，未截断；没有时为空字符串
  messageCount?: number;
  stored?: StoredSession;        // 未写入存储的登记会话没有
  lastActivityAt?: string;       // 存储目录的活动时间与登记会话最近活动时间中较新的
  registered: boolean;
  hosted: boolean;               // 是否有 pi 进程
  status: NodeStatus;            // 未登记时为 idle
  holds: { source: string; reason: string }[];
}

/** 校验并转换 PiStore.list 的一行；缺少标识、路径或目录的行不进入目录。 */
export function toStoredSession(row: any): StoredSession | undefined {
  if (typeof row?.id !== "string" || typeof row.path !== "string" || typeof row.cwd !== "string") return undefined;
  const date = (value: unknown) => value instanceof Date ? value : new Date(typeof value === "string" || typeof value === "number" ? value : NaN);
  return {
    id: row.id, file: row.path, cwd: row.cwd, name: normalizeSessionName(row.name),
    firstText: typeof row.firstUserText === "string" ? row.firstUserText : typeof row.firstMessage === "string" ? row.firstMessage : "",
    created: date(row.created), modified: date(row.modified),
    messageCount: Number.isSafeInteger(row.messageCount) ? row.messageCount : 0,
    ...(typeof row.parentSessionPath === "string" ? { parentSessionFile: row.parentSessionPath } : {}),
  };
}

function iso(date: Date | undefined): string | undefined { return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined; }

export function catalogEntry(id: string, stored: StoredSession | undefined, live: LiveSession | undefined): CatalogEntry {
  if (!live) return { id, file: stored!.file, cwd: stored!.cwd, ...(stored!.name === undefined ? {} : { name: stored!.name }), firstText: stored!.firstText,
    messageCount: stored!.messageCount, stored, ...(iso(stored!.modified) ? { lastActivityAt: iso(stored!.modified) } : {}),
    registered: false, hosted: false, status: "idle", holds: [] };
  const name = live.name ? live.name.value : stored?.name;
  const firstText = live.name || !stored ? firstUserText(live.entries) : stored.firstText;
  const active = new Date(live.lastActive); const modified = stored?.modified;
  const lastActivityAt = iso(modified && Number.isFinite(modified.getTime()) && modified.getTime() > active.getTime() ? modified : active);
  return { id, file: live.file, cwd: live.cwd, ...(name === undefined ? {} : { name }), firstText,
    messageCount: live.entries.filter((entry) => entry.type === "message").length, ...(stored ? { stored } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}), registered: true, hosted: live.hosted, status: live.status, holds: live.holds };
}

/** 插件协议的标题以会话 id 作最后回退；前端列表的标题保留空字符串，由前端决定占位文字。 */
export function toMainSessionInfo(entry: CatalogEntry): MainSessionInfo {
  return { ref: { source: "pane", id: entry.id }, nodeId: `pane:session:${entry.id}`, cwd: entry.cwd, sessionFile: entry.file,
    title: sessionTitle(entry.name, entry.firstText, entry.id), hosted: entry.hosted, status: entry.status };
}

/** 主会话树的一行；活动时间取较新的值，未登记会话的保活原因为空。 */
export function toMainTreeRow(entry: CatalogEntry): MainTreeRow {
  return { info: toMainSessionInfo(entry), ...(entry.lastActivityAt === undefined ? {} : { lastActivityAt: entry.lastActivityAt }),
    ...(entry.messageCount === undefined ? {} : { messageCount: entry.messageCount }), ...(entry.registered ? { holds: entry.holds } : {}) };
}
