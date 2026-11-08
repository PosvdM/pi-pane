// 聊天视图中单个条目的渲染（plugin-api.md“三种投影”的 ② 用户聊天视图）。
// 模型输出、工具参数和结果都按不可信内容处理：Markdown 经安全渲染，其余按纯文本显示。
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { renderMarkdown } from "../lib/markdown.ts";
import { DISPLAYABLE, useBlobUrl } from "../lib/blobs.ts";
import type { Entry } from "../lib/session-model.ts";
import type { InFlightBlock } from "../lib/types.ts";

export interface ToolContext {
  results: Map<string, any>;                       // toolCallId → toolResult 消息
  running: Map<string, { partialResult?: unknown }>; // 执行中的工具
  showHidden: boolean;                             // 设置“显示隐藏消息”
}

export function Markdown({ text }: { text: string }) {
  return <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function imageSource(block: any): string | null {
  if (typeof block.blob === "string" && /^sha256-[a-f0-9]{64}$/.test(block.blob)) return `/api/blobs/${block.blob}`;
  return null;
}

export function ImageBlock({ block, label }: { block: any; label?: string }) {
  const path = imageSource(block);
  const url = useBlobUrl(path && DISPLAYABLE.includes(block.mimeType) ? path : null);
  const inline = !path && typeof block.data === "string" && DISPLAYABLE.includes(block.mimeType) ? `data:${block.mimeType};base64,${block.data}` : null;
  const [zoom, setZoom] = useState(false);
  if (!DISPLAYABLE.includes(block.mimeType)) return <span class="file-chip">{block.mimeType ?? "未知类型"}{block.size ? ` · ${block.size} 字节` : ""}</span>;
  const src = url ?? inline;
  return (
    <span class={"msg-image" + (zoom ? " zoom" : "")} title={label}>
      {src ? <img src={src} alt={label ?? "图片"} onClick={() => setZoom(!zoom)} /> : <span class="img-loading">图片加载中…</span>}
    </span>
  );
}

const LABEL = /\[Image #(\d+)\]/g;
/** 用户消息：按 content 顺序渲染文字与图片；文字中的 [Image #k] 显示为编号标签，悬停显示第 k 张图。 */
function UserContent({ content }: { content: any }) {
  const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const images = blocks.filter((b) => b.type === "image");
  let imageIndex = 0;
  return (
    <div class="user-text">
      {blocks.map((block, i) => {
        if (block.type === "image") { imageIndex++; return <ImageBlock key={i} block={block} label={`Image #${imageIndex}`} />; }
        if (block.type !== "text") return null;
        const parts: any[] = []; let last = 0; let match: RegExpExecArray | null;
        LABEL.lastIndex = 0;
        while ((match = LABEL.exec(block.text))) {
          parts.push(block.text.slice(last, match.index));
          const k = Number(match[1]); const target = images[k - 1];
          parts.push(target ? <ImageLabel key={match.index} k={k} block={target} /> : match[0]);
          last = match.index + match[0].length;
        }
        parts.push(block.text.slice(last));
        return <span key={i}>{parts}</span>;
      })}
    </div>
  );
}

function ImageLabel({ k, block }: { k: number; block: any }) {
  const [hover, setHover] = useState(false);
  return (
    <span class="img-label" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      [Image #{k}]{hover && <span class="img-pop"><ImageBlock block={block} /></span>}
    </span>
  );
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div class="thinking">
      <button class="link" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} 思考{streaming ? "中…" : ""}</button>
      {open && <div class="thinking-body">{text}</div>}
    </div>
  );
}

function summarize(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const value = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? args.query;
  if (typeof value === "string") return value.length > 120 ? value.slice(0, 120) + "…" : value;
  const text = JSON.stringify(args);
  return name && text.length > 120 ? text.slice(0, 120) + "…" : text;
}

function resultText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

function Clipped({ text, limit = 4000 }: { text: string; limit?: number }) {
  const [all, setAll] = useState(false);
  if (text.length <= limit || all) return <pre class="plain">{text}</pre>;
  return <div><pre class="plain">{text.slice(0, limit)}</pre><button class="link" onClick={() => setAll(true)}>显示全部（{text.length} 字符）</button></div>;
}

/** edit 工具的差异：旧文本按 - 行、新文本按 + 行显示。 */
function EditDiff({ args }: { args: any }) {
  const edits: { oldText?: string; newText?: string }[] = Array.isArray(args?.edits) ? args.edits : [{ oldText: args?.oldText ?? args?.old_string, newText: args?.newText ?? args?.new_string }];
  if (!edits.some((e) => typeof e.oldText === "string" || typeof e.newText === "string")) return null;
  return (
    <div class="diff">
      {edits.map((edit, i) => (
        <div key={i} class="diff-hunk">
          {(edit.oldText ?? "").split("\n").map((line, j) => <div key={"o" + j} class="del">- {line}</div>)}
          {(edit.newText ?? "").split("\n").map((line, j) => <div key={"n" + j} class="add">+ {line}</div>)}
        </div>
      ))}
    </div>
  );
}

export function ToolCard({ id, name, args, argsText, result, running, partial, pending }: {
  id: string; name: string; args?: any; argsText?: string; result?: any; running?: boolean; partial?: any; pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const error = result?.isError;
  const state = result ? (error ? "错误" : "完成") : running ? "运行中" : pending ? "生成参数中" : "等待结果";
  const images = Array.isArray(result?.content) ? result.content.filter((b: any) => b.type === "image") : [];
  const output = result ? resultText(result) : partial ? resultText(partial) : "";
  return (
    <div class={"tool" + (error ? " error" : "") + (result ? "" : " live")} data-testid="tool-card" data-tool-call-id={id}>
      <button class="tool-head" onClick={() => setOpen(!open)}>
        <span class="tool-name">{name || "工具"}</span>
        <span class="tool-sum">{summarize(name, args) || (argsText ? argsText.slice(0, 80) : "")}</span>
        <span class={"tool-state" + (error ? " bad" : result ? " ok" : "")}>{state}</span>
      </button>
      {(name === "edit") && args && <EditDiff args={args} />}
      {open && (
        <div class="tool-body">
          <div class="tool-label">参数</div>
          <Clipped text={args !== undefined ? JSON.stringify(args, null, 2) : argsText ?? ""} />
          {(output || images.length > 0) && <div class="tool-label">{result ? "结果" : "输出（进行中）"}</div>}
          {output && <Clipped text={output} />}
          {images.map((b: any, i: number) => <ImageBlock key={i} block={b} />)}
        </div>
      )}
    </div>
  );
}

function AssistantContent({ message, ctx }: { message: any; ctx: ToolContext }) {
  const content: any[] = Array.isArray(message.content) ? message.content : [];
  return (
    <div class="assistant">
      {content.map((block, i) => {
        if (block.type === "text") return <Markdown key={i} text={block.text ?? ""} />;
        if (block.type === "thinking") return <Thinking key={i} text={block.redacted ? "（思考内容已加密）" : block.thinking ?? ""} />;
        if (block.type === "toolCall") {
          const running = ctx.running.get(block.id);
          return <ToolCard key={i} id={block.id} name={block.name} args={block.arguments} result={ctx.results.get(block.id)} running={!!running} partial={running?.partialResult} />;
        }
        return null;
      })}
      {(message.stopReason === "error" || message.stopReason === "aborted") && (
        <div class="notice">{message.stopReason === "aborted" ? "已中止" : `出错：${message.errorMessage ?? "未知错误"}`}</div>
      )}
    </div>
  );
}

/** 进行中的助手消息（由 message_update 重建的块）。 */
export function StreamingBlocks({ blocks, ctx }: { blocks: InFlightBlock[]; ctx: ToolContext }) {
  return (
    <div class="msg assistant-msg streaming" data-testid="streaming">
      <div class="assistant">
        {blocks.map((block) => {
          if (block.type === "text") return <Markdown key={block.contentIndex} text={block.text} />;
          if (block.type === "thinking") return <Thinking key={block.contentIndex} text={block.text} streaming={!block.done} />;
          const running = ctx.running.get(block.id);
          return <ToolCard key={block.contentIndex} id={block.id} name={block.toolName} args={block.args} argsText={block.argsText} pending={!block.done} running={!!running} partial={running?.partialResult} result={block.id ? ctx.results.get(block.id) : undefined} />;
        })}
        {!blocks.length && <span class="typing">正在生成…</span>}
      </div>
    </div>
  );
}

function Card({ title, children, open: initial = false, testid }: { title: string; children: any; open?: boolean; testid?: string }) {
  const [open, setOpen] = useState(initial);
  return (
    <div class="card" data-testid={testid}>
      <button class="card-head" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {title}</button>
      {open && <div class="card-body">{children}</div>}
    </div>
  );
}

function CustomContent({ content }: { content: any }) {
  if (typeof content === "string") return <Markdown text={content} />;
  if (!Array.isArray(content)) return null;
  return <>{content.map((b: any, i: number) => b.type === "text" ? <Markdown key={i} text={b.text} /> : b.type === "image" ? <ImageBlock key={i} block={b} /> : null)}</>;
}

export function MessageView({ message, ctx }: { message: any; ctx: ToolContext }) {
  switch (message?.role) {
    case "user": return <div class="msg user-msg" data-testid="user-message"><UserContent content={message.content} /></div>;
    case "assistant": return <div class="msg assistant-msg" data-testid="assistant-message"><AssistantContent message={message} ctx={ctx} /></div>;
    case "toolResult": return <div class="msg"><ToolCard id={message.toolCallId} name={message.toolName} result={message} /></div>;
    case "bashExecution":
      return <div class="msg"><Card title={`$ ${message.command}`}><Clipped text={message.output ?? ""} />{message.exitCode ? <div class="notice">退出码 {message.exitCode}</div> : null}</Card></div>;
    case "custom":
      if (!message.display && !ctx.showHidden) return null;
      return <div class="msg"><Card title={message.customType ?? "自定义消息"} testid="custom-message"><CustomContent content={message.content} /></Card></div>;
    case "branchSummary": return <div class="msg"><Card title="分支摘要"><Markdown text={message.summary ?? ""} /></Card></div>;
    case "compactionSummary": return <div class="compaction"><span>以上内容已压缩</span></div>;
    default: return null;
  }
}

function CompactionMarker({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="compaction" data-testid="compaction">
      <button class="link" onClick={() => setOpen(!open)}>以上内容已压缩{entry.tokensBefore ? `（压缩前 ${entry.tokensBefore} tokens）` : ""} {open ? "▾" : "▸"}</button>
      {open && <div class="card-body"><Markdown text={entry.summary ?? ""} /></div>}
    </div>
  );
}

/** 条目的工具状态签名：只有其中工具调用的结果或运行状态变化时才重新渲染该条目。 */
export function toolKey(entry: Entry, ctx: ToolContext): string {
  const content = entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content) ? entry.message.content : [];
  return content.filter((b: any) => b.type === "toolCall").map((b: any) => `${ctx.results.has(b.id) ? "r" : ""}${ctx.running.has(b.id) ? "x" + identity(ctx.running.get(b.id)?.partialResult) : ""}`).join(",") + (ctx.showHidden ? "h" : "");
}

/** 每次 tool_execution_update 都带来新的 partialResult 对象；按对象身份编号，内容等长时也能识别变化。 */
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? "");
  let id = identities.get(value);
  if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
  return "#" + id;
}

export const EntryView = memo(function EntryView({ entry, ctx }: { entry: Entry; ctx: ToolContext; toolKey: string }) {
  switch (entry.type) {
    case "message": return <MessageView message={entry.message} ctx={ctx} />;
    case "custom_message":
      return <MessageView message={{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details }} ctx={ctx} />;
    case "compaction": return <CompactionMarker entry={entry} />;
    case "branch_summary": return <div class="msg"><Card title="分支摘要"><Markdown text={entry.summary ?? ""} /></Card></div>;
    case "model_change": return <div class="meta-line">模型切换为 {entry.provider}/{entry.modelId}</div>;
    case "thinking_level_change": return <div class="meta-line">思考级别：{entry.thinkingLevel}</div>;
    default: return null;
  }
}, (a, b) => a.entry === b.entry && a.toolKey === b.toolKey);
