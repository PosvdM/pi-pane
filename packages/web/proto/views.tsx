// 主区域：主会话聊天、插件会话视图、节点面板、横幅与通知。
import { useState } from "preact/hooks";
import type { BannerState, FormSpec, PanelContent, TreeNode } from "@pi-pane/plugin-api";
import { EntryView, Markdown, StreamingBlocks, ToolCard, type ToolContext } from "../src/components/Message.tsx";
import {
  ACTIONS, ASK_ENTRIES, FAILED_ENTRIES, MAIN_ENTRIES, NOTIFICATION, PANEL_CONTENT, PANELS, PLUGIN_NODES, SPAWN_CALLS, SUB_ENTRIES, SUB_RUNNING, SUB_STREAM,
} from "./data.ts";
import { STATUS_TEXT, StatusIcon, nodeTitle } from "./tree.tsx";

const emptyCtx = (running = new Map()): ToolContext => ({ results: new Map(), running, showHidden: false });
function ctxFor(entries: any[], running?: Map<string, any>): ToolContext {
  const ctx = emptyCtx(running);
  for (const e of entries) if (e.message?.role === "toolResult") ctx.results.set(e.message.toolCallId, e.message);
  return ctx;
}
const visible = (entries: any[]) => entries.filter((e) => e.message?.role !== "toolResult");

/** 静态输入框，结构和类名与 Composer 一致。 */
function ComposerMock({ placeholder, running, images, hint }: { placeholder: string; running?: boolean; images?: boolean; hint?: string }) {
  return (
    <div class="composer-wrap">
      {hint && <div class="composer-hint">{hint}</div>}
      <div class="composer">
        <div class="editor empty" data-placeholder={placeholder} />
        <div class="composer-actions">
          {images !== false && <label class="btn ghost">添加图片</label>}
          <span class="spacer" />
          {running && <button class="btn danger" title="取消当前运行并清空队列">停止</button>}
          <button class="btn primary" disabled>发送</button>
        </div>
      </div>
    </div>
  );
}

// ───────── 主会话 ─────────

function SpawnCard({ call, onOpen }: { call: typeof SPAWN_CALLS[number]; onOpen: (id: string) => void }) {
  const node = PLUGIN_NODES.find((n) => n.id === call.nodeId)!;
  return (
    <div class="tool-linked">
      <ToolCard id={call.id} name="agora_task" args={call.args} result={{ content: [{ type: "text", text: "已派出" }] }} />
      <button class="tool-node-link" onClick={() => onOpen(node.id)}>
        <StatusIcon status={node.status} /><span>打开 {node.title}</span><span class="muted">{STATUS_TEXT[node.status]}</span><span class="spacer" /><span>›</span>
      </button>
    </div>
  );
}

/** agora:notice 按插件声明的 CustomMessageRenderer 渲染：label、fields 键值行、nodeIdPath 链接。 */
function NoticeCard({ onOpen }: { onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div class="msg"><div class="card custom-card">
      <button class="card-head" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} agora 通知</button>
      {open && <div class="card-body">
        <Markdown text={"子代理 **为 TreeStore 补单元测试** 已完成：新增 14 个用例，全部通过。"} />
        <table class="kv"><tbody><tr><th>taskId</th><td><code>as_b1</code></td></tr><tr><th>generation</th><td>1</td></tr></tbody></table>
        <button class="link small" onClick={() => onOpen("agora:session:as_b1")}>打开 为 TreeStore 补单元测试 ›</button>
      </div>}
    </div></div>
  );
}

export function MainChat({ onOpen }: { onOpen: (id: string) => void }) {
  const ctx = emptyCtx();
  return (
    <div class="chat" data-testid="chat">
      <div class="chat-head">
        <div class="title-block"><div class="title">M3 插件界面实现</div><div class="subtitle">/Users/pm/code/pi-pane</div></div>
        <div class="head-meta">
          <span class="status-dot s-idle" /><span>空闲</span>
          <button class="chip-btn">anthropic/claude-opus-5-5</button>
          <button class="chip-btn">思考：high</button>
          <button class="chip-btn">上下文 38% · 412.7k tokens · $3.18</button>
          <button class="chip-btn">关闭</button>
        </div>
      </div>
      <div class="banner muted-banner">保活：等待子代理（3 个）</div>
      <div class="messages">
        {MAIN_ENTRIES.map((e) => <EntryView key={e.id} entry={e} ctx={ctx} toolKey="" />)}
        <div class="msg assistant-msg"><div class="assistant">
          <Markdown text="拆成四个子任务并行，彼此不改同一批文件。先派前三个，设备密钥迁移等额度恢复后再派。" />
          {SPAWN_CALLS.map((c) => <SpawnCard key={c.id} call={c} onOpen={onOpen} />)}
        </div></div>
        <NoticeCard onOpen={onOpen} />
        <div class="msg assistant-msg"><div class="assistant">
          <Markdown text="测试子任务已完成。**横幅落盘与恢复** 失败了（Windows 上替换被占用的文件），需要你决定返工方式；**调研 Chrome 虚拟列表** 有一个提问转给了你，在左侧 **待处理** 里。" />
        </div></div>
      </div>
      <ComposerMock placeholder="输入消息，Enter 发送，Shift+Enter 换行，/ 查看命令" />
    </div>
  );
}

// ───────── 插件会话 ─────────

function capabilityActions(node: TreeNode) {
  return node.capabilities.filter((c) => c.startsWith("action:")).map((c) => ACTIONS[c.slice(7)]).filter(Boolean);
}

export function PluginSession({ node, panelOpen, onPanel, onOpen, forms, onForm }: {
  node: TreeNode; panelOpen: boolean; onPanel: () => void; onOpen: (id: string) => void; forms: FormSpec[]; onForm: (form: FormSpec) => void;
}) {
  const running = node.status === "running";
  const entries = node.id === "agora:session:as_a3" ? FAILED_ENTRIES : node.id === "agora:session:as_b2" ? ASK_ENTRIES : SUB_ENTRIES;
  const ctx = ctxFor(entries, running ? SUB_RUNNING : undefined);
  const canSend = node.capabilities.includes("send");
  const parent = node.parentId ?? "";
  const steer = node.composer && ACTIONS[node.composer.actionId];
  return (
    <div class="chat" data-testid="plugin-session">
      <div class="chat-head">
        <div class="title-block">
          <div class="crumbs"><button class="link" onClick={() => onOpen(parent)}>{nodeTitle(parent)}</button><span class="muted"> › </span></div>
          <div class="title">{node.title}<span class="node-badge head-badge">{node.badge}</span><span class="src-tag">{node.source}</span></div>
        </div>
        <div class="head-meta">
          <StatusIcon status={node.status} />
          <span title={node.statusDetail}>{STATUS_TEXT[node.status]}{running ? " · 执行工具" : ""}</span>
          {capabilityActions(node).map((a) => <button key={a.id} class={"btn small-btn" + (a.danger ? " danger" : "")} title={a.confirm}>{a.title}</button>)}
          <button class={"chip-btn" + (panelOpen ? " on" : "")} onClick={onPanel} title="显示或隐藏节点面板">详情</button>
        </div>
      </div>
      {forms.filter((f) => f.nodeId === node.id).map((f) => (
        <div key={f.id} class="banner warn">待处理：{f.title}<button class="btn small" onClick={() => onForm(f)}>处理</button></div>
      ))}
      {node.status === "failed" && <div class="banner error">任务失败：{node.statusDetail}</div>}
      <div class="messages">
        {visible(entries).map((e) => <EntryView key={e.id} entry={e} ctx={ctx} toolKey="" />)}
        {running && <StreamingBlocks blocks={SUB_STREAM} ctx={ctx} />}
      </div>
      {canSend
        ? <ComposerMock placeholder={node.composer?.placeholder ?? "输入消息"} running={node.capabilities.includes("abort") && running} images={node.composer?.images === true}
            hint={steer ? `发送的文字作为“${steer.title}”提交给 ${node.source}${running ? "，不中断当前运行" : ""}` : undefined} />
        : <div class="readonly-bar">
            <span>只读：{node.availability === "archived" ? "会话已存档" : "没有向该会话发消息的权限"}</span>
            {node.capabilities.includes("abort") && node.status !== "done" && <button class="btn danger small-btn" title="取消当前运行并清空队列">停止</button>}
          </div>}
      <div class="statusbar"><span>{node.statusDetail}</span><span>来源：{node.source}</span></div>
    </div>
  );
}

// ───────── 节点面板 ─────────

function PanelBody({ content }: { content?: PanelContent }) {
  if (!content) return <div class="muted pad">加载中…</div>;
  switch (content.type) {
    case "keyValue": return <table class="kv panel-kv"><tbody>{content.rows.map((r) => <tr key={r.key}><th>{r.key}</th><td>{r.value}</td></tr>)}</tbody></table>;
    case "markdown": return <Markdown text={content.markdown} />;
    case "list": return <div>{content.items.map((i) => <div key={i.id} class="panel-li"><span>{i.title}</span>{i.subtitle && <span class="muted small">{i.subtitle}</span>}</div>)}</div>;
    case "table": return (
      <table class="kv"><thead><tr>{content.columns.map((c) => <th key={c.key}>{c.title}</th>)}</tr></thead>
        <tbody>{content.rows.map((r) => <tr key={r.rowId}>{content.columns.map((c) => <td key={c.key}>{r.cells[c.key]}</td>)}</tr>)}</tbody></table>
    );
    default: return <div class="muted pad">此面板需要更新的 pi-pane</div>;
  }
}

export function NodePanel({ node, onClose }: { node: TreeNode; onClose: () => void }) {
  const panels = PANELS.filter((p) => p.placement === "node" && (!p.appliesTo?.kinds || p.appliesTo.kinds.includes(node.kind)) && (!p.appliesTo?.sources || p.appliesTo.sources.includes(node.source)));
  const [tab, setTab] = useState(panels[0]?.id);
  if (!panels.length) return null;
  return (
    <aside class="node-panel" data-testid="node-panel">
      <div class="panel-head">
        {panels.map((p) => <button key={p.id} class={"panel-tab" + (p.id === tab ? " on" : "")} onClick={() => setTab(p.id)}>{p.title}</button>)}
        <span class="spacer" />
        <span class="src-tag">{panels[0].source}</span>
        <button class="icon-btn" title="隐藏面板" onClick={onClose}>✕</button>
      </div>
      <div class="panel-body"><PanelBody content={PANEL_CONTENT[node.id]} /></div>
    </aside>
  );
}

// ───────── 横幅与通知 ─────────

function Banner({ banner, initialOpen }: { banner: BannerState; initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div class={"g-banner lv-" + banner.level + (banner.sourceUnavailable ? " unavailable" : "")} data-testid="global-banner">
      <div class="g-banner-line" onClick={() => setOpen(!open)}>
        <span class="g-icon">{banner.level === "error" ? "⛔" : banner.level === "warning" ? "⚠" : "ℹ"}</span>
        <span class="g-title">{banner.title}</span>
        {banner.sourceUnavailable && <span class="g-unavail">来源插件不可用，无法确认当前状态</span>}
        <span class="spacer" />
        <span class="src-tag">{banner.source}</span>
        <button class="link small">{open ? "收起" : "展开"}</button>
      </div>
      {open && (
        <div class="g-banner-body">
          {banner.body && <Markdown text={banner.body} />}
          {banner.actions?.length ? <div class="row">{banner.actions.map((id) => <button key={id} class="btn" disabled={banner.sourceUnavailable}>{ACTIONS[id]?.title ?? id}</button>)}</div> : null}
        </div>
      )}
    </div>
  );
}

export function BannerStack({ banners, expanded }: { banners: BannerState[]; expanded: string[] }) {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...banners].sort((a, b) => order[a.level] - order[b.level]);
  if (!sorted.length) return null;
  return <div class="g-banners">{sorted.map((b) => <Banner key={b.source + ":" + b.id} banner={b} initialOpen={expanded.includes(b.id)} />)}</div>;
}

export function NotificationToast({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const n = NOTIFICATION;
  return (
    <div class="toasts proto-toasts">
      <div class={"toast " + n.level} data-testid="notification">
        <div class="toast-main">
          <div class="toast-title">{n.title}</div>
          {n.body && <Markdown text={n.body} />}
          <div class="toast-actions">
            {n.nodeId && <button class="btn small-btn" onClick={() => onOpen(n.nodeId!)}>打开</button>}
            <span class="muted small">{n.source} · 刚刚</span>
          </div>
        </div>
        <button class="icon-btn" aria-label="关闭" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
