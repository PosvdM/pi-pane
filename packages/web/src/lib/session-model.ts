// 浏览器端会话模型：以快照为起点，按游标顺序应用 pane 协议的会话事件（plugin-api.md“事件流”）。
// 纯逻辑，不依赖 DOM，测试直接在 Node.js 中运行。
import type { InFlightBlock, InFlightState, PaneSessionView, SessionRef, SessionStreamEvent } from "./types.ts";

export interface Entry { type: string; id: string; parentId: string | null; [key: string]: any }

export interface ModelState {
  view: PaneSessionView;
  entries: Entry[];               // 已加载的聊天分支，旧在前
  replaced?: { newRef: SessionRef; reason: string };
  detail?: string;
  diagnostics: string[];
  version: number;                // 每次变化加 1，供界面判断是否需要重新渲染
}

export type ApplyResult = "applied" | "duplicate" | "resync";

export function fromSnapshot(view: PaneSessionView): ModelState {
  return { view: structuredClone(view), entries: (view.entries as Entry[]).slice(), diagnostics: [], version: 0 };
}

export function prependHistory(state: ModelState, entries: Entry[], historyBefore: string | null): void {
  const known = new Set(state.entries.map((e) => e.id));
  state.entries = [...entries.filter((e) => !known.has(e.id)), ...state.entries];
  state.view.historyBefore = historyBefore;
  state.version++;
}

/**
 * 重取快照后保留已加载的更早历史。条目树只追加、parentId 不变（plugin-api.md“历史水位”）：新快照的第一条在旧模型中时，
 * 旧模型里排在它之前的条目都是它的祖先，接在新快照之前，历史水位沿用旧模型的。第一条不在旧模型中（如换了分支）时不保留。
 */
export function keepLoadedHistory(next: ModelState, prev: ModelState): void {
  if (next.view.historyBefore === null) return;   // 快照已含到开头的全部条目
  const first = next.entries[0]; if (!first) return;
  const index = prev.entries.findIndex((e) => e.id === first.id);
  if (index <= 0) return;
  next.entries = [...prev.entries.slice(0, index), ...next.entries];
  next.view.historyBefore = prev.view.historyBefore;
}

const idle = (): InFlightState => ({ phase: "idle", tools: [], queue: { steering: [], followUp: [] } });

/**
 * 应用一条事件。游标不连续或 epoch 变化时返回 resync，调用方重新取快照。
 * resync 事件不按游标去重：提供方（包括服务端在插件事件出错时的兜底）可能用订阅起点作为它的游标。
 */
export function apply(state: ModelState, record: SessionStreamEvent): ApplyResult {
  const cursor = state.view.cursor;
  const event = record.event as any;
  if (event?.type === "resync") return "resync";
  if (record.cursor.epoch !== cursor.epoch) return "resync";
  if (record.cursor.seq <= cursor.seq) return "duplicate";
  if (record.cursor.seq !== cursor.seq + 1) return "resync";
  state.view.cursor = { ...record.cursor };
  const inFlight = state.view.inFlight ??= idle();
  switch (event.type) {
    case "pane_entries": {
      const known = new Set(state.entries.map((e) => e.id));
      const fresh = (event.entries as Entry[]).filter((e) => !known.has(e.id));
      state.entries = [...state.entries, ...fresh];
      state.view.leafId = event.leafId;
      // 与服务端（model.ts 的 persistedSignature）相同：按消息身份移除已经持久化的 completed 项，custom_message 对应 custom 消息。
      for (const entry of fresh) {
        const signature = persistedSignature(entry); if (signature === undefined) continue;
        const completed = inFlight.completed ?? [];
        const i = completed.findIndex((m) => messageSignature(m) === signature);
        if (i >= 0) completed.splice(i, 1);
      }
      break;
    }
    case "pane_status":
      state.view.status = event.status; inFlight.phase = event.phase;
      if (typeof event.controlRevision === "number") state.view.controlRevision = event.controlRevision;
      if (typeof event.readonly === "boolean") state.view.readonly = event.readonly;
      if (event.holds) state.view.holds = event.holds;
      state.detail = event.detail;
      if (event.phase === "idle") inFlight.retry = undefined;
      break;
    case "pane_session_replaced": state.replaced = { newRef: event.newRef, reason: event.reason }; break;
    case "pane_diagnostic": state.diagnostics = [...state.diagnostics.slice(-19), String(event.message ?? "")]; break;
    case "message_start":
      if (event.message?.role === "assistant") inFlight.assistant = { startedAt: event.message.timestamp ?? Date.now(), blocks: [] };
      break;
    case "message_update": updateAssistant(inFlight, event); break;
    case "message_end":
      (inFlight.completed ??= []).push(event.message);
      if (event.message?.role === "assistant") inFlight.assistant = undefined;
      break;
    case "tool_execution_start":
      inFlight.tools = [...inFlight.tools.filter((t) => t.toolCallId !== event.toolCallId), { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, startedAt: Date.now() }];
      break;
    case "tool_execution_update":
      inFlight.tools = inFlight.tools.map((t) => t.toolCallId === event.toolCallId ? { ...t, partialResult: event.partialResult } : t);
      break;
    case "tool_execution_end": inFlight.tools = inFlight.tools.filter((t) => t.toolCallId !== event.toolCallId); break;
    case "queue_update": inFlight.queue = { steering: event.steering ?? [], followUp: event.followUp ?? [] }; break;
    case "auto_retry_start": inFlight.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage }; break;
    case "auto_retry_end": inFlight.retry = undefined; break;
    case "agent_settled": inFlight.tools = []; break;
  }
  state.version++;
  return "applied";
}

function updateAssistant(inFlight: InFlightState, event: any): void {
  const delta = event.assistantMessageEvent; if (!delta) return;
  const assistant: NonNullable<InFlightState["assistant"]> = inFlight.assistant ??= { startedAt: event.message?.timestamp ?? Date.now(), blocks: [] };
  assistant.usage = event.message?.usage ?? delta.partial?.usage ?? assistant.usage;
  const i = delta.contentIndex; if (!Number.isInteger(i)) return;
  let block = assistant.blocks.find((b) => b.contentIndex === i);
  if (typeof delta.type !== "string") return;
  if (delta.type.endsWith("_start")) {
    const type = delta.type.slice(0, -6);
    block = type === "toolcall" ? { type: "toolCall", contentIndex: i, id: "", toolName: "", argsText: "", done: false }
      : { type, contentIndex: i, text: "", done: false } as InFlightBlock;
    assistant.blocks = [...assistant.blocks.filter((b) => b.contentIndex !== i), block].sort((a, b) => a.contentIndex - b.contentIndex);
    return;
  }
  if (!block) return;
  const next = { ...block } as InFlightBlock;
  if (delta.type.endsWith("_delta")) { if (next.type === "toolCall") next.argsText += delta.delta ?? ""; else next.text += delta.delta ?? ""; }
  if (delta.type.endsWith("_end")) {
    next.done = true;
    if (next.type === "toolCall") { next.id = delta.toolCall?.id ?? ""; next.toolName = delta.toolCall?.name ?? ""; next.args = delta.toolCall?.arguments; }
    else next.text = delta.content ?? next.text;
  }
  assistant.blocks = assistant.blocks.map((b) => b.contentIndex === i ? next : b);
}

function messageSignature(message: any): string {
  return message?.role === "custom"
    ? JSON.stringify(["custom", message.customType, message.content, !!message.display, message.details ?? null])
    : JSON.stringify(message);
}
function persistedSignature(entry: any): string | undefined {
  if (entry?.type === "message") return messageSignature(entry.message);
  if (entry?.type === "custom_message") return JSON.stringify(["custom", entry.customType, entry.content, !!entry.display, entry.details ?? null]);
  return undefined;
}
