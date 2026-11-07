import { randomUUID } from "node:crypto";
import type { HistoryPage, InFlightBlock, InFlightState, NodeStatus, SessionRef, SessionSnapshot, SessionStreamEvent, StreamCursor, UnfinishedPartial } from "@pi-pane/plugin-api";
import { branch, type Entry } from "./store.js";
import type { AssetStore } from "./assets.js";
import { assert } from "./errors.js";

const idle = (): InFlightState => ({ phase: "idle", tools: [], queue: { steering: [], followUp: [] } });
export class SessionModel {
  epoch = randomUUID(); seq = 0; controlRevision = 0; status: NodeStatus = "idle";
  readonly = true; readonlyReason?: SessionSnapshot["readonlyReason"] = "archived";
  entries: Entry[] = []; leafId: string | null = null; inFlight = idle(); unfinishedPartials: UnfinishedPartial[] = [];
  private events: SessionStreamEvent[] = []; private eventBytes = 0;
  private listeners = new Set<(event: SessionStreamEvent) => void>();
  constructor(public ref: SessionRef, private readonly assets: AssetStore, readonly bufferSize = 2000, private readonly maxBufferBytes = 32 * 1024 * 1024) {}
  reset(entries: Entry[], leafId: string | null, clearPartials = false): void {
    this.epoch = randomUUID(); this.seq = 0; this.events = []; this.eventBytes = 0;
    this.entries = this.assets.detach(entries); this.leafId = leafId; this.inFlight = idle();
    if (clearPartials) this.unfinishedPartials = [];
    this.emit({ type: "resync" });
  }
  emit(event: { type: string; [key: string]: any }): SessionStreamEvent {
    const record: SessionStreamEvent = { ref: { ...this.ref }, cursor: { epoch: this.epoch, seq: ++this.seq }, event: this.assets.detach(event) };
    const size = Buffer.byteLength(JSON.stringify(record)); this.events.push(record); this.eventBytes += size;
    while (this.events.length > this.bufferSize || this.eventBytes > this.maxBufferBytes && this.events.length > 1) this.eventBytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!));
    for (const listener of this.listeners) listener(structuredClone(record));
    return record;
  }
  control(status: NodeStatus, phase: InFlightState["phase"], detail?: string, force = false): void {
    const changed = status !== this.status || phase !== this.inFlight.phase;
    this.status = status; this.inFlight.phase = phase;
    if (changed || force) { this.controlRevision++; this.emit({ type: "pane_status", status, phase, controlRevision: this.controlRevision, readonly: this.readonly, ...(detail ? { detail } : {}) }); }
  }
  interrupt(runId: string, detail: string): void {
    if (this.inFlight.assistant?.blocks.length) this.unfinishedPartials.push({ runId, at: new Date().toISOString(), blocks: structuredClone(this.inFlight.assistant.blocks) });
    this.readonly = true; this.readonlyReason = "archived"; this.control("interrupted", "idle", detail, true);
    this.inFlight.assistant = undefined;
  }
  apply(event: any): void {
    switch (event.type) {
      case "agent_start": this.control("running", "streaming"); break;
      case "agent_settled": this.control("idle", "idle"); this.inFlight.tools = []; break;
      case "compaction_start": this.control("running", "compacting"); break;
      case "compaction_end": this.control("running", "streaming"); break;
      case "auto_retry_start": this.inFlight.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage }; this.control("running", "retrying"); break;
      case "auto_retry_end": this.inFlight.retry = undefined; break;
      case "message_start":
        if (event.message?.role === "assistant") this.inFlight.assistant = { startedAt: event.message.timestamp ?? Date.now(), blocks: [] };
        break;
      case "message_update": this.updateAssistant(event); break;
      case "message_end": {
        const message = this.assets.detach(event.message);
        (this.inFlight.completed ??= []).push(message);
        if (message?.role === "assistant") this.inFlight.assistant = undefined;
        break;
      }
      case "tool_execution_start":
        this.inFlight.tools.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, startedAt: Date.now() }); this.control("running", "tools"); break;
      case "tool_execution_update": {
        const tool = this.inFlight.tools.find((t) => t.toolCallId === event.toolCallId); if (tool) tool.partialResult = this.assets.detach(event.partialResult); break;
      }
      case "tool_execution_end": this.inFlight.tools = this.inFlight.tools.filter((t) => t.toolCallId !== event.toolCallId); break;
      case "queue_update": this.inFlight.queue = { steering: event.steering ?? [], followUp: event.followUp ?? [] }; break;
      case "model_select": case "thinking_level_select": this.control(this.status, this.inFlight.phase, undefined, true); break;
    }
    this.emit(event);
  }
  private updateAssistant(event: any): void {
    const delta = event.assistantMessageEvent; if (!delta) return;
    const assistant: NonNullable<InFlightState["assistant"]> = this.inFlight.assistant ??= { startedAt: event.message?.timestamp ?? Date.now(), blocks: [] };
    assistant.usage = event.message?.usage ?? delta.partial?.usage;
    const i = delta.contentIndex; if (!Number.isInteger(i)) return;
    let block = assistant.blocks.find((b) => b.contentIndex === i);
    if (delta.type.endsWith("_start")) {
      const type = delta.type.slice(0, -6);
      block = type === "toolcall" ? { type: "toolCall", contentIndex: i, id: "", toolName: "", argsText: "", done: false }
        : { type, contentIndex: i, text: "", done: false } as InFlightBlock;
      assistant.blocks = assistant.blocks.filter((b) => b.contentIndex !== i); assistant.blocks.push(block); assistant.blocks.sort((a, b) => a.contentIndex - b.contentIndex);
    }
    if (!block) return;
    if (delta.type.endsWith("_delta")) { if (block.type === "toolCall") block.argsText += delta.delta ?? ""; else block.text += delta.delta ?? ""; }
    if (delta.type.endsWith("_end")) {
      block.done = true;
      if (block.type === "toolCall") { block.id = delta.toolCall?.id ?? ""; block.toolName = delta.toolCall?.name ?? ""; block.args = delta.toolCall?.arguments; }
      else block.text = delta.content ?? block.text;
    }
  }
  append(entries: Entry[], leafId: string | null): void {
    const known = new Set(this.entries.map((e) => e.id)); const fresh = this.assets.detach(entries.filter((e) => !known.has(e.id)));
    const previous = this.leafId; this.entries.push(...fresh); this.leafId = leafId;
    const active = branch(this.entries, leafId);
    if (previous && leafId !== previous && !active.some((e) => e.id === previous)) {
      this.reset(this.entries, leafId); return;
    }
    // message_end 先于落盘；按完整消息身份移除已持久化项，不能清掉响应之后才完成的消息。
    for (const entry of fresh) if (entry.type === "message") {
      const completed = this.inFlight.completed ?? []; const signature = JSON.stringify(entry.message);
      const i = completed.findIndex((message) => JSON.stringify(message) === signature); if (i >= 0) completed.splice(i, 1);
    }
    if (fresh.length) this.emit({ type: "pane_entries", entries: fresh, leafId });
  }
  snapshot(limit = 50): SessionSnapshot {
    const active = branch(this.entries, this.leafId); const page = active.slice(-Math.max(1, Math.min(limit, 500)));
    return structuredClone({ ref: this.ref, cursor: { epoch: this.epoch, seq: this.seq }, entries: page, leafId: this.leafId,
      historyBefore: active.length > page.length ? page[0].id : null, inFlight: this.inFlight,
      ...(this.unfinishedPartials.length ? { unfinishedPartials: this.unfinishedPartials } : {}), status: this.status,
      controlRevision: this.controlRevision, readonly: this.readonly, ...(this.readonly && this.readonlyReason ? { readonlyReason: this.readonlyReason } : {}) });
  }
  history(before: string, limit = 50): HistoryPage {
    const active = branch(this.entries, this.leafId); const index = active.findIndex((e) => e.id === before);
    assert(index >= 0, "historyChanged", "历史水位不在当前分支，请重新读取快照", 409);
    const page = active.slice(Math.max(0, index - Math.max(1, Math.min(limit, 500))), index);
    return structuredClone({ entries: page, historyBefore: index > page.length ? page[0].id : null });
  }
  subscribe(after: StreamCursor, listener: (event: SessionStreamEvent) => void): () => void {
    const invalid = after.epoch !== this.epoch || !Number.isSafeInteger(after.seq) || after.seq < 0 || after.seq > this.seq || after.seq < (this.events[0]?.cursor.seq ?? this.seq + 1) - 1;
    if (invalid) { listener({ ref: { ...this.ref }, cursor: { epoch: this.epoch, seq: this.seq }, event: { type: "resync" } }); return () => {}; }
    for (const event of this.events) if (event.cursor.seq > after.seq) listener(structuredClone(event));
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
}
