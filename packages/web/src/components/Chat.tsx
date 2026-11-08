// 会话视图：标题栏、状态横条、聊天记录、扩展控件与输入框。
import { useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { useStore } from "../lib/store.ts";
import { closeSession, current, loadOlder, open, openFile, restart } from "../lib/session.ts";
import { extensionUi, emptyUi, overlay } from "../lib/ui-state.ts";
import { settings } from "../lib/settings.ts";
import { Composer } from "./Composer.tsx";
import { EntryView, MessageView, StreamingBlocks, toolKey, type ToolContext } from "./Message.tsx";

const STATUS_TEXT: Record<string, string> = {
  idle: "空闲", running: "运行中", waiting: "等待中", paused: "已暂停", done: "已完成", failed: "失败", stopped: "已停止", interrupted: "已中断",
};
const PHASE_TEXT: Record<string, string> = {
  streaming: "生成中", tools: "执行工具", compacting: "压缩中", retrying: "重试中", waitingUi: "等待回应", stopping: "正在停止",
};

function money(value: number): string { return value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`; }
function tokens(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }

function firstUserText(entries: { type: string; message?: any }[]): string {
  for (const entry of entries) {
    const content = entry.type === "message" && entry.message?.role === "user" ? entry.message.content : undefined;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
    if (text.trim()) return text.trim().slice(0, 80);
  }
  return "";
}

function Header() {
  const state = useStore(current)!;
  const view = state.model!.view;
  const model = view.state?.model;
  const stats = state.stats;
  const phase = view.inFlight?.phase ?? "idle";
  return (
    <div class="chat-head">
      <div class="title-block">
        <div class="title" data-testid="session-title">{view.state?.sessionName || firstUserText(state.model!.entries) || "新会话"}</div>
        <div class="subtitle" title={view.sessionFile}>{view.cwd}</div>
      </div>
      <div class="head-meta">
        <span class={"status-dot s-" + view.status} />
        <span data-testid="session-status">{phase !== "idle" && PHASE_TEXT[phase] ? PHASE_TEXT[phase] : STATUS_TEXT[view.status] ?? view.status}</span>
        {view.hosted ? (
          <>
            <button class="chip-btn" data-testid="model-button" onClick={() => overlay.set("models")} title="切换模型">{model ? `${model.provider}/${model.id}` : "选择模型"}</button>
            {(!model || model.reasoning) && <button class="chip-btn" data-testid="thinking-button" onClick={() => overlay.set("thinking")} title="思考级别">思考：{view.state?.thinkingLevel ?? "—"}</button>}
          </>
        ) : <span class="muted">未启动（发送消息后启动 pi）</span>}
        {stats && (
          <button class="chip-btn" data-testid="usage" onClick={() => overlay.set("session-info")} title="用量与费用">
            {stats.context?.percent != null ? `上下文 ${Math.round(stats.context.percent)}% · ` : ""}{tokens(stats.tokens.total)} tokens · {money(stats.cost)}
          </button>
        )}
        {view.hosted && <button class="chip-btn" onClick={() => void closeSession()} title="停止 pi 进程并关闭会话">关闭</button>}
      </div>
    </div>
  );
}

function Banners() {
  const state = useStore(current)!;
  const model = state.model!; const view = model.view;
  const banners: any[] = [];
  if (model.replaced) banners.push(
    <div class="banner warn" data-testid="replaced-banner">此会话的进程已切换到另一个会话。<button class="btn small" onClick={() => void open(model.replaced!.newRef.id)}>打开新会话</button></div>,
  );
  if (view.readonlyReason === "externalWriter") banners.push(
    <div class="banner warn" data-testid="external-writer">该会话可能正在别处运行{state.heldBy ? `（由 ${state.heldBy} 托管）` : ""}，只能查看。<button class="btn small" onClick={() => void openFile(view.cwd, view.sessionFile, true)}>Fork 为新会话</button></div>,
  );
  else if (state.warning === "recentModification") banners.push(
    <div class="banner warn" data-testid="recent-warning">该会话可能正在别处运行（文件在一分钟内被修改过），当前为只读打开。<button class="btn small" onClick={() => void openFile(view.cwd, view.sessionFile, true)}>Fork 为新会话</button></div>,
  );
  if (view.status === "interrupted") banners.push(
    <div class="banner error" data-testid="interrupted">会话已中断{model.detail ? `：${model.detail}` : ""}。<button class="btn small" onClick={() => void restart()}>重启</button></div>,
  );
  if (view.inFlight?.retry) banners.push(<div class="banner">第 {view.inFlight.retry.attempt}/{view.inFlight.retry.maxAttempts} 次重试：{view.inFlight.retry.errorMessage}</div>);
  if (view.projectTrusted === false) banners.push(<div class="banner muted-banner">项目资源未加载（项目未被信任）。AGENTS.md 等上下文文件不受信任设置影响，始终加载。</div>);
  if (view.holds.length) banners.push(<div class="banner muted-banner">保活：{view.holds.map((h) => h.reason).join("；")}</div>);
  return <>{banners}</>;
}

function Widgets({ placement, id }: { placement: "aboveEditor" | "belowEditor"; id: string }) {
  const ui = useStore(extensionUi)[id] ?? emptyUi();
  const list = Object.entries(ui.widgets).filter(([, w]) => w.placement === placement);
  if (!list.length) return null;
  return <div class="widgets">{list.map(([key, w]) => <pre key={key} class="widget" data-testid="widget">{w.lines.join("\n")}</pre>)}</div>;
}

function Statuses({ id }: { id: string }) {
  const ui = useStore(extensionUi)[id] ?? emptyUi();
  const state = useStore(current);
  const detail = state?.model?.detail;
  const entries = Object.entries(ui.statuses);
  if (!entries.length && !detail) return null;
  return <div class="statusbar" data-testid="statusbar">{detail && <span>{detail}</span>}{entries.map(([key, text]) => <span key={key}>{text}</span>)}</div>;
}

export function ChatView() {
  const state = useStore(current)!;
  const prefs = useStore(settings);
  const model = state.model!;
  const view = model.view;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inFlight = view.inFlight;
  const completed = inFlight?.completed ?? [];

  const ctx: ToolContext = useMemo(() => {
    const results = new Map<string, any>();
    for (const entry of model.entries) if (entry.type === "message" && entry.message?.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
    for (const message of completed as any[]) if (message?.role === "toolResult") results.set(message.toolCallId, message);
    const running = new Map((inFlight?.tools ?? []).map((t) => [t.toolCallId, { partialResult: t.partialResult }]));
    return { results, running, showHidden: prefs.showHidden };
  }, [model.version, prefs.showHidden]);
  const called = useMemo(() => {
    const ids = new Set<string>();
    const scan = (message: any) => { if (message?.role === "assistant" && Array.isArray(message.content)) for (const b of message.content) if (b.type === "toolCall") ids.add(b.id); };
    for (const entry of model.entries) if (entry.type === "message") scan(entry.message);
    for (const message of completed) scan(message);
    for (const block of inFlight?.assistant?.blocks ?? []) if (block.type === "toolCall" && block.id) ids.add(block.id);
    return ids;
  }, [model.version]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { stick.current = true; }, [state.id]);

  const visible = (message: any) => !(message?.role === "toolResult" && called.has(message.toolCallId));
  return (
    <div class="chat" data-testid="chat" data-session-id={state.id}>
      <Header />
      <Banners />
      <div class="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {view.historyBefore && <button class="btn ghost load-older" onClick={() => void loadOlder()}>加载更早的消息</button>}
        {model.entries.map((entry) => (entry.type === "message" && !visible(entry.message)) ? null : <EntryView key={entry.id} entry={entry} ctx={ctx} toolKey={toolKey(entry, ctx)} />)}
        {completed.filter(visible).map((message: any, i: number) => <MessageView key={"c" + i} message={message} ctx={ctx} />)}
        {inFlight?.assistant && <StreamingBlocks blocks={inFlight.assistant.blocks} ctx={ctx} />}
        {view.unfinishedPartials?.map((partial) => (
          <div key={partial.runId + partial.at} class="unfinished" data-testid="unfinished">
            <div class="muted">中断时正在生成的内容</div>
            <StreamingBlocks blocks={partial.blocks} ctx={ctx} />
          </div>
        ))}
        {!model.entries.length && !completed.length && !inFlight?.assistant && <div class="empty-chat">开始对话：在下方输入消息。</div>}
      </div>
      <Widgets id={state.id} placement="aboveEditor" />
      <Composer sessionId={state.id} model={model} commands={state.commands} />
      <Widgets id={state.id} placement="belowEditor" />
      <Statuses id={state.id} />
    </div>
  );
}
