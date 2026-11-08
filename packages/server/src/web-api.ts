// 浏览器与 pi-pane 服务端之间的 HTTP/WebSocket 数据类型。
// 会话事件流和条目沿用 plugin-api.md 的 pane 协议；本文件定义协议之外、由服务端从 pi 原始形状转换而来的结构。
// 前端只以 `import type` 引用本文件，pi 的 RPC 信封只出现在服务端。
import type { DraftNode, NodeStatus, SessionRef, SessionSnapshot } from "@pi-pane/plugin-api";

/** 会话列表的一行。不含消息全文等大字段。 */
export interface PaneSessionListItem {
  sessionFile: string;
  id: string;                      // pi 会话 id
  cwd: string;
  name?: string;                   // 用户设置的会话名称
  title: string;                   // 首条用户消息的前 200 个字符；没有时为空字符串
  createdAt: string;               // ISO 时间
  modifiedAt: string;              // ISO 时间
  messageCount: number;
  parentSessionFile?: string;
  hosted: boolean;                 // 是否有 pi 进程托管
  status?: NodeStatus;             // 已在服务端登记时的状态
}
export interface PaneSessionList { sessions: PaneSessionListItem[] }

export type PaneThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PaneModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  images: boolean;                 // 是否接受图片输入
  contextWindow?: number;
}

export interface PaneSessionState {
  sessionId: string;
  sessionFile: string;
  sessionName?: string;
  model?: PaneModel;
  thinkingLevel?: PaneThinkingLevel;
  running: boolean;
  compacting: boolean;
  pendingMessages: number;
}

export interface PaneCommand {
  name: string;                    // 不含前导 "/"
  description?: string;
  source: "extension" | "prompt" | "skill";
  scope?: "user" | "project" | "temporary";
}

export interface PaneSessionStats {
  messages: { user: number; assistant: number; toolCalls: number; total: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;                    // 美元
  context?: { tokens: number | null; window: number; percent: number | null };
}

export interface PaneForkPoint { entryId: string; text: string }

/** POST /api/sessions/:id/query 的请求与响应。 */
export type PaneQueryType = "state" | "models" | "commands" | "stats" | "forkPoints";
export interface PaneQueryResults {
  state: PaneSessionState;
  models: { models: PaneModel[] };
  commands: { commands: PaneCommand[] };
  stats: PaneSessionStats;
  forkPoints: { points: PaneForkPoint[] };
}

/** GET /api/sessions/:id/snapshot 与打开会话的响应。 */
export interface PaneSessionView extends SessionSnapshot {
  cwd: string;
  sessionFile: string;
  hosted: boolean;
  state?: PaneSessionState;        // 托管后最近一次读取的状态
  projectTrusted?: boolean;        // pane-bridge 报告的实际信任结果
  holds: { source: string; reason: string }[];
}
export interface PaneOpenResult extends PaneSessionView {
  diagnostics?: string[];
  heldBy?: string;                 // 写锁持有者，如 "pi-agora"
  warning?: "recentModification";
}

/** POST /api/sessions/:id/control 的请求。命令名沿用 development.md 的控制命令表。 */
export type PaneControlCommand =
  | { type: "prompt"; message?: string;
      // 会话运行中发送技能、提示模板等经 prompt 展开的输入时使用；扩展命令立即执行，忽略此字段。
      delivery?: "steer" | "followUp" }
  | { type: "steer" | "follow_up"; message?: string }
  | { type: "stop" }
  | { type: "close"; confirmHolds?: boolean }
  | { type: "restart"; assumeNoWriter?: boolean }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: PaneThinkingLevel }
  | { type: "compact"; customInstructions?: string }
  | { type: "new_session" }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "set_session_name"; name: string }
  | { type: "export" };
export interface PaneControlRequest {
  requestId: string;
  expectedEpoch: string;
  expectedRevision: number;
  command: PaneControlCommand;
  draft?: DraftNode[];
}

/** 控制命令的结果。HTTP 等待到期为 pending，用同一 requestId 重新提交查询当前状态。 */
export type PaneControlResult =
  | { status: "accepted"; snapshot: PaneSessionView; result?: PaneCommandOutcome }
  | { status: "done"; clearedText: string[]; clearedDrafts: DraftNode[][] }
  | { status: "nothingToStop" }
  | { status: "pending" };
/** 输入类命令的处理方式与其他命令的附加结果。 */
export interface PaneCommandOutcome {
  handled?: boolean;               // 输入被扩展的输入处理器消费，不进入队列
  cancelled?: boolean;             // new_session、fork、clone 被扩展取消
  exportId?: string;               // export 的下载标识，见 GET /api/exports/:id
}

/** 错误响应体；HTTP 状态码见 architecture.md。 */
export interface PaneErrorBody { error: string; message: string; instanceId: string }

/** pi 扩展 UI 请求，经 WebSocket `ui_request` 推送。对话框带 expiresAt 时到期由 pi 按默认值处理。 */
export type PaneUiRequest =
  | { id: string; kind: "select"; title: string; options: string[]; expiresAt?: string }
  | { id: string; kind: "confirm"; title: string; message?: string; expiresAt?: string }
  | { id: string; kind: "input"; title: string; placeholder?: string; expiresAt?: string }
  | { id: string; kind: "editor"; title: string; prefill?: string; expiresAt?: string }
  | { id: string; kind: "notify"; message: string; level: "info" | "warning" | "error" }
  | { id: string; kind: "status"; key: string; text?: string }
  | { id: string; kind: "widget"; key: string; lines?: string[]; placement: "aboveEditor" | "belowEditor" }
  | { id: string; kind: "title"; title: string }
  | { id: string; kind: "editorText"; text: string };

/** POST /api/sessions/:id/ui 的请求；省略 answer 表示取消对话框。 */
export interface PaneUiAnswerRequest {
  requestId: string;
  expectedEpoch: string;
  id: string;
  answer?: { value: string } | { confirmed: boolean };
}
export type PaneUiAnswerResult = { status: "done" } | { status: "alreadyHandled" };

export interface PaneTrustRequest { id: string; cwd: string; expiresAt: string }

/** 服务端经 WebSocket 推送给浏览器的消息。 */
export type PaneServerMessage =
  | { type: "banners"; banners: unknown[]; paneProtocol?: number; connectionId?: string }
  | ({ type: "session" } & import("@pi-pane/plugin-api").SessionStreamEvent)
  | { type: "ui_request"; ref: SessionRef; request: PaneUiRequest }
  | { type: "ui_resolved"; ref: SessionRef; id: string; reason: "answered" | "cancelled" | "expired" | "closed" }
  | { type: "project_trust"; request: PaneTrustRequest }
  | { type: "project_trust_resolved"; id: string }
  | { type: "pong" };
