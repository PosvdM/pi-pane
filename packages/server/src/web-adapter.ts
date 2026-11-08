import type { NodeStatus } from "@pi-pane/plugin-api";
import { assert } from "./errors.js";
import type { ControlRequest, ExtensionUiRequest } from "./pi-rpc.js";
import type {
  PaneCommandOutcome, PaneModel, PaneQueryResults, PaneQueryType, PaneSessionListItem,
  PaneSessionState, PaneUiRequest,
} from "./web-api.js";

/** pi SessionInfo 的列表字段；消息全文不属于浏览器协议。 */
export interface PiSessionListRow {
  path: string; id: string; cwd: string; name?: string; firstMessage: string;
  created: Date; modified: Date; messageCount: number; parentSessionPath?: string;
}
export function toPaneSessionListItem(row: PiSessionListRow, hosted: boolean, status?: NodeStatus): PaneSessionListItem {
  return {
    sessionFile: row.path, id: row.id, cwd: row.cwd, title: (row.messageCount === 0 && row.firstMessage === "(no messages)" ? "" : row.firstMessage).slice(0, 200),
    createdAt: row.created.toISOString(), modifiedAt: row.modified.toISOString(), messageCount: row.messageCount,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.parentSessionPath === undefined ? {} : { parentSessionFile: row.parentSessionPath }),
    hosted, ...(status === undefined ? {} : { status }),
  };
}
export function toPaneModel(model: any): PaneModel {
  return { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning === true,
    images: model.input?.includes("image") === true, ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) };
}
export function toPaneState(state: any): PaneSessionState {
  return { sessionId: state.sessionId, sessionFile: state.sessionFile,
    ...(state.sessionName === undefined ? {} : { sessionName: state.sessionName }),
    ...(state.model ? { model: toPaneModel(state.model) } : {}),
    ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
    running: state.isStreaming === true, compacting: state.isCompacting === true, pendingMessages: state.pendingMessageCount ?? 0 };
}
export const queryCommands = {
  state: "get_state", models: "get_available_models", commands: "get_commands", stats: "get_session_stats", forkPoints: "get_fork_messages",
} as const satisfies Record<PaneQueryType, string>;
export function isPaneQueryType(type: unknown): type is PaneQueryType {
  return typeof type === "string" && Object.hasOwn(queryCommands, type);
}
export function toPaneQuery<T extends PaneQueryType>(type: T, data: any): PaneQueryResults[T] {
  let result: PaneQueryResults[PaneQueryType];
  switch (type) {
    case "state": result = toPaneState(data); break;
    case "models": result = { models: data.models.map(toPaneModel) }; break;
    case "commands": result = { commands: data.commands.map((command: any) => ({
      name: command.name, source: command.source,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.sourceInfo?.scope === undefined ? {} : { scope: command.sourceInfo.scope }),
    })) }; break;
    case "stats": result = {
      messages: { user: data.userMessages, assistant: data.assistantMessages, toolCalls: data.toolCalls, total: data.totalMessages },
      tokens: { input: data.tokens.input, output: data.tokens.output, cacheRead: data.tokens.cacheRead, cacheWrite: data.tokens.cacheWrite, total: data.tokens.total },
      cost: data.cost, ...(data.contextUsage ? { context: { tokens: data.contextUsage.tokens, window: data.contextUsage.contextWindow, percent: data.contextUsage.percent } } : {}),
    }; break;
    case "forkPoints": result = { points: data.messages.map((point: any) => ({ entryId: point.entryId, text: point.text })) }; break;
    default: throw new Error("会话查询类型无效");
  }
  return result as PaneQueryResults[T];
}
export function toPiControlCommand(command: ControlRequest["command"]): ControlRequest["command"] {
  const { delivery, ...rpc } = command;
  if ("delivery" in command) {
    assert(command.type === "prompt" && (delivery === "steer" || delivery === "followUp"), "invalidCommand", "delivery 仅适用于 prompt，取值为 steer 或 followUp");
    rpc.streamingBehavior = delivery;
  }
  return rpc;
}
export function toPaneOutcome(type: string, data: any): PaneCommandOutcome | undefined {
  if (["prompt", "steer", "follow_up"].includes(type) && data?.disposition === "handled") return { handled: true };
  if (["new_session", "fork", "clone"].includes(type) && data?.cancelled === true) return { cancelled: true };
  return undefined;
}
export type PaneUiDialog = Extract<PaneUiRequest, { kind: "select" | "confirm" | "input" | "editor" }>;
export function isUiDialog(request: PaneUiRequest): request is PaneUiDialog {
  return ["select", "confirm", "input", "editor"].includes(request.kind);
}
export function toPaneUiRequest(raw: ExtensionUiRequest, receivedAt: number): PaneUiRequest | undefined {
  const event = raw as any;
  const dialog = { id: event.id, title: event.title,
    ...(Number.isFinite(event.timeout) && event.timeout >= 0 ? { expiresAt: new Date(receivedAt + event.timeout).toISOString() } : {}) };
  switch (event.method) {
    case "select": return { ...dialog, kind: "select", options: [...event.options] };
    case "confirm": return { ...dialog, kind: "confirm", ...(event.message === undefined ? {} : { message: event.message }) };
    case "input": return { ...dialog, kind: "input", ...(event.placeholder === undefined ? {} : { placeholder: event.placeholder }) };
    case "editor": return { ...dialog, kind: "editor", ...(event.prefill === undefined ? {} : { prefill: event.prefill }) };
    case "notify": return { id: event.id, kind: "notify", message: event.message, level: event.notifyType ?? "info" };
    case "setStatus": return { id: event.id, kind: "status", key: event.statusKey, ...(event.statusText === undefined ? {} : { text: event.statusText }) };
    case "setWidget": return { id: event.id, kind: "widget", key: event.widgetKey, placement: event.widgetPlacement ?? "aboveEditor", ...(event.widgetLines === undefined ? {} : { lines: [...event.widgetLines] }) };
    case "setTitle": return { id: event.id, kind: "title", title: event.title };
    case "set_editor_text": return { id: event.id, kind: "editorText", text: event.text };
    default: return undefined;
  }
}
export function toPiUiAnswer(request: PaneUiDialog, answer: unknown): { id: string; value?: string; confirmed?: boolean; cancelled?: boolean } {
  if (answer === undefined) return { id: request.id, cancelled: true };
  assert(answer !== null && typeof answer === "object" && !Array.isArray(answer), "invalidUiAnswer", "对话框回答格式无效");
  const keys = Object.keys(answer); const value = answer as Record<string, unknown>;
  if (request.kind === "confirm") {
    assert(keys.length === 1 && typeof value.confirmed === "boolean", "invalidUiAnswer", "确认对话框需要 confirmed 布尔值");
    return { id: request.id, confirmed: value.confirmed };
  }
  assert(keys.length === 1 && typeof value.value === "string", "invalidUiAnswer", "此对话框需要 value 文本值");
  assert(request.kind !== "select" || request.options.includes(value.value), "invalidUiAnswer", "所选值不在对话框选项中");
  return { id: request.id, value: value.value };
}
