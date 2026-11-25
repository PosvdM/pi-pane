// 插件节点视图：会话节点显示聊天记录、动作、输入框或只读条；group 和 resource 节点只显示面板（plugin-api.md“会话视图”“向会话发消息与停止”“面板”）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, newId } from "../lib/api.ts";
import { openNodeById } from "../lib/navigate.ts";
import { link } from "../lib/ws.ts";
import { abortPlugin, loadOlder, pluginView, sendToPlugin } from "../lib/plugin-session.ts";
import { formKey, forms, openForm, runAction, sortedForms } from "../lib/plugin-ui.ts";
import { actionSpec, pluginName, plugins } from "../lib/plugins.ts";
import { settings } from "../lib/settings.ts";
import { useStore } from "../lib/store.ts";
import { findNode, trees } from "../lib/tree.ts";
import { toast } from "../lib/ui-state.ts";
import type { TreeNode } from "../lib/types.ts";
import { EntryView, MessageView, StreamingBlocks, toolKey, type ToolContext } from "./Message.tsx";
import { panelsFor, PanelView } from "./Panels.tsx";
import { nodeActions, STATUS_TEXT, StatusIcon } from "./Sidebar.tsx";

const PHASE_TEXT: Record<string, string> = { streaming: "生成中", tools: "执行工具", compacting: "压缩中", retrying: "重试中", waitingUi: "等待回应", stopping: "正在停止" };
const READONLY_TEXT: Record<string, string> = { archived: "会话已存档", externalWriter: "会话正由其他程序写入", noPermission: "没有向该会话发消息的权限" };

/** 面包屑：从根到父节点，主会话也可点击。 */
function Crumbs({ node }: { node: TreeNode }) {
  const chain: TreeNode[] = [];
  let parent = node.parentId ? findNode(node.parentId) : undefined;
  while (parent && chain.length < 8) { chain.unshift(parent); parent = parent.parentId ? findNode(parent.parentId) : undefined; }
  if (!chain.length) return null;
  return (
    <div class="crumbs" data-testid="crumbs">
      {chain.map((n) => <span key={n.id}><button class="link" onClick={() => openNodeById(n.id)}>{n.title}</button><span class="muted"> › </span></span>)}
    </div>
  );
}

/** 节点面板：可在多个适用面板之间切换，“详情”按钮控制显示。 */
function NodePanel({ node, onClose }: { node: TreeNode; onClose?: () => void }) {
  const state = useStore(plugins);
  const panels = panelsFor(node, Object.values(state.catalogs).flatMap((c) => c.panels));
  const [tab, setTab] = useState<string | undefined>(panels[0]?.id);
  const panel = panels.find((p) => p.id === tab) ?? panels[0];
  if (!panel) return onClose ? null : <div class="placeholder">该节点没有可显示的内容。</div>;
  return (
    <aside class={"node-panel" + (onClose ? "" : " full")} data-testid="node-panel">
      <div class="panel-head">
        {panels.map((p) => <button key={p.source + p.id} class={"panel-tab" + (p.id === panel.id ? " on" : "")} onClick={() => setTab(p.id)}>{p.title}</button>)}
        <span class="spacer" />
        <span class="src-tag">{pluginName(panel.source)}</span>
        {onClose && <button class="icon-btn" title="隐藏面板" onClick={onClose}>✕</button>}
      </div>
      <div class="panel-body"><PanelView panel={panel} nodeId={node.id} onOpenNode={openNodeById} /></div>
    </aside>
  );
}

function PluginComposer({ node, running }: { node: TreeNode; running: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const composer = node.composer;
  const action = composer && actionSpec(node.source, composer.actionId);
  useEffect(() => { setText(""); }, [node.id]);
  // 停止的语义是取消：清出的待发文本按原顺序放回输入框。
  const stop = async () => { const cleared = await abortPlugin(); if (cleared?.length) setText((value) => [...cleared, value].filter(Boolean).join("\n")); };
  const submit = async () => {
    const value = text.trim(); if (!value || busy) return;
    setBusy(true);
    try {
      if (composer) {
        // 有 composer 时改为调用指定动作，文字放在 input.fields.message。
        if (!actionSpec(node.source, composer.actionId)) { toast("插件没有声明输入框使用的动作", "error"); return; }
        setText("");
        await invokeComposer(node, composer.actionId, value);
      } else if (await sendToPlugin(value, running ? delivery : undefined)) setText("");
    } finally { setBusy(false); }
  };
  return (
    <div class="composer-wrap" data-testid="plugin-composer">
      {action && <div class="composer-hint">发送的文字作为“{action.title}”提交给 {pluginName(node.source)}{running ? "，不中断当前运行" : ""}</div>}
      <div class="composer">
        <textarea class="editor plain-editor" data-testid="plugin-editor" rows={2} value={text} placeholder={composer?.placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } }} />
        <div class="composer-actions">
          {!composer && running && (
            <select class="chip-btn" value={delivery} onChange={(e) => setDelivery(e.currentTarget.value as "steer" | "followUp")} title="运行中发送的方式">
              <option value="steer">插话（steer）</option><option value="followUp">排队（follow-up）</option>
            </select>
          )}
          <span class="spacer" />
          {node.capabilities.includes("abort") && running && <button class="btn danger" data-testid="plugin-stop" title="取消当前运行并清空队列" onClick={() => void stop()}>停止</button>}
          <button class="btn primary" data-testid="plugin-send" disabled={!text.trim() || busy} onClick={() => void submit()}>发送</button>
        </div>
      </div>
    </div>
  );
}

async function invokeComposer(node: TreeNode, actionId: string, message: string): Promise<void> {
  // 输入框动作不弹表单：文字直接作为 input.fields.message。
  try {
    const result = await api<any>(`/api/plugins/${encodeURIComponent(node.source)}/actions/${encodeURIComponent(actionId)}/invoke`, {
      idempotencyKey: newId(), connectionId: link.get().connectionId, target: { type: "node", nodeId: node.id }, input: { answers: [], fields: { message } },
    });
    if (result.status === "failed" || result.status === "idempotencyConflict") toast(result.message, "error");
    else if (result.status === "pending") toast(result.message ?? "已提交，处理中");
  } catch (error) { toast((error as Error).message, "error"); }
}

export function PluginSessionView() {
  const view = useStore(pluginView)!;
  useStore(trees);
  const formMap = useStore(forms);
  const prefs = useStore(settings);
  const [panelOpen, setPanelOpen] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const node = findNode(view.nodeId);
  const model = view.model;
  const inFlight = model?.view.inFlight;
  const completed = inFlight?.completed ?? [];
  const ctx: ToolContext = useMemo(() => {
    const results = new Map<string, any>();
    for (const entry of model?.entries ?? []) if (entry.type === "message" && entry.message?.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
    for (const message of completed as any[]) if (message?.role === "toolResult") results.set(message.toolCallId, message);
    const running = new Map((inFlight?.tools ?? []).map((t) => [t.toolCallId, { partialResult: t.partialResult }]));
    return { results, running, showHidden: prefs.showHidden, ...(view.ref ? { sessionRef: view.ref } : {}) };
  }, [model?.version, prefs.showHidden, view.ref?.id]);
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });
  useEffect(() => { stick.current = true; }, [view.nodeId]);
  if (!node) return <div class="placeholder">该节点已不在会话列表中。</div>;
  const pending = sortedForms(formMap.values()).filter((f) => f.nodeId === node.id);
  const status = model?.view.status ?? node.status;
  const running = status === "running" || (inFlight?.phase ?? "idle") !== "idle";
  const phase = inFlight?.phase ?? "idle";
  const actions = nodeActions(node);
  const readonly = model ? model.view.readonly : !node.capabilities.includes("send");
  const canSend = node.capabilities.includes("send") && !readonly;
  const stop = async () => { const cleared = await abortPlugin(); if (cleared?.length) toast("已停止，清出的待发消息：" + cleared.join(" / ")); };  // 只读视图没有输入框
  const pendingBanner = pending.map((f) => (
    <div key={f.id} class="banner warn" data-testid="node-pending-banner">待处理：{f.title}<button class="btn small" onClick={() => openForm.set({ key: formKey(f.source, f.id), persistent: true, form: f })}>处理</button></div>
  ));
  const head = (
    <div class="chat-head">
      <div class="title-block">
        <Crumbs node={node} />
        <div class="title" data-testid="plugin-title">{node.title}{node.badge && <span class="node-badge head-badge">{node.badge}</span>}<span class="src-tag">{pluginName(node.source)}</span></div>
      </div>
      <div class="head-meta">
        <StatusIcon status={status} />
        <span data-testid="plugin-status" title={node.statusDetail}>{STATUS_TEXT[status]}{phase !== "idle" && PHASE_TEXT[phase] ? " · " + PHASE_TEXT[phase] : ""}</span>
        {actions.map((a) => <button key={a.id} class={"btn small-btn" + (a.danger ? " danger" : "")} data-testid="node-head-action" title={a.confirm}
          onClick={() => void runAction(node.source, a.id, { type: "node", nodeId: node.id }, openNodeById)}>{a.title}</button>)}
        {node.kind === "session" && <button class={"chip-btn" + (panelOpen ? " on" : "")} onClick={() => setPanelOpen(!panelOpen)} title="显示或隐藏节点面板">详情</button>}
      </div>
    </div>
  );
  if (node.kind !== "session") {
    return <div class="main-split"><div class="chat" data-testid="plugin-node">{head}{pendingBanner}<NodePanel node={node} /></div></div>;
  }
  return (
    <div class="main-split">
      <div class="chat" data-testid="plugin-session" data-node-id={node.id}>
        {head}
        {pendingBanner}
        {(status === "failed" || status === "interrupted") && node.statusDetail && <div class="banner error">{STATUS_TEXT[status]}：{node.statusDetail}</div>}
        {view.error && <div class="banner error">{view.error}</div>}
        <div class="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {view.loading && <div class="muted pad">加载中…</div>}
          {model?.view.historyBefore && <button class="btn ghost load-older" onClick={() => void loadOlder()}>加载更早的消息</button>}
          {model?.entries.map((entry) => entry.type === "message" && entry.message?.role === "toolResult" ? null : <EntryView key={entry.id} entry={entry} ctx={ctx} toolKey={toolKey(entry, ctx)} />)}
          {completed.filter((m: any) => m?.role !== "toolResult").map((message: any, i: number) => <MessageView key={"c" + i} message={message} ctx={ctx} />)}
          {inFlight?.assistant && <StreamingBlocks blocks={inFlight.assistant.blocks} ctx={ctx} />}
          {view.partials.map((partial) => (
            <div key={partial.runId + partial.at} class="unfinished" data-testid="unfinished">
              <div class="muted">中断时正在生成的内容</div>
              <StreamingBlocks blocks={partial.blocks} ctx={ctx} />
            </div>
          ))}
          {model && !model.entries.length && !inFlight?.assistant && <div class="empty-chat">还没有消息。</div>}
        </div>
        {canSend ? <PluginComposer node={node} running={running} /> : (
          <div class="readonly-bar" data-testid="plugin-readonly">
            <span>只读：{READONLY_TEXT[model?.view.readonlyReason ?? ""] ?? (node.availability === "archived" ? "会话已存档" : "没有向该会话发消息的权限")}</span>
            {node.capabilities.includes("abort") && running && <button class="btn danger small-btn" data-testid="plugin-stop" title="取消当前运行并清空队列" onClick={() => void stop()}>停止</button>}
          </div>
        )}
        <div class="statusbar">{node.statusDetail && <span>{node.statusDetail}</span>}<span>来源：{pluginName(node.source)}</span></div>
      </div>
      {panelOpen && <NodePanel node={node} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
