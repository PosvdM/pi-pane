// 插件节点视图：会话节点显示聊天记录、动作、输入框或只读条；group 和 resource 节点只显示面板（plugin-api.md“会话视图”“向会话发消息与停止”“面板”）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { openNodeById } from "../lib/navigate.ts";
import { abortPlugin, loadOlder, pluginView, sendToPlugin, syncCapabilities } from "../lib/plugin-session.ts";
import { restoreText, splitActions } from "../lib/plugin-state.ts";
import { formKey, forms, invokeAction, openForm, runAction, sortedForms } from "../lib/plugin-ui.ts";
import { actionSpec, pluginName } from "../lib/plugins.ts";
import { settings } from "../lib/settings.ts";
import { Store, useStore } from "../lib/store.ts";
import { findNode, trees } from "../lib/tree.ts";
import { toast } from "../lib/ui-state.ts";
import type { ActionSpec, TreeNode } from "../lib/types.ts";
import { EntryView, MessageView, StreamingBlocks, toolKey, type ToolContext } from "./Message.tsx";
import { DetailsButton, NodePanels, useDetails, useNodePanels } from "./Panels.tsx";
import { nodeActions, STATUS_TEXT, StatusIcon } from "./Sidebar.tsx";

const PHASE_TEXT: Record<string, string> = { streaming: "生成中", tools: "执行工具", compacting: "压缩中", retrying: "重试中", waitingUi: "等待回应", stopping: "正在停止" };
const READONLY_TEXT: Record<string, string> = { archived: "会话已存档", externalWriter: "该会话可能正在别处运行", noPermission: "没有向该会话发消息的权限" };

/** 面包屑：从根到父节点，主会话也可点击。 */
function Crumbs({ node }: { node: TreeNode }) {
  const chain: TreeNode[] = [];
  let parent = node.parentId ? findNode(node.parentId) : undefined;
  while (parent && chain.length < 8) { chain.unshift(parent); parent = parent.parentId ? findNode(parent.parentId) : undefined; }
  if (!chain.length) return null;
  return (
    <div class="crumbs" data-testid="crumbs">
      {chain.map((n) => {
        // 主会话树的项目分组以目录为标题，只显示最后一级。
        const title = n.source === "pane" && n.kind === "group" ? n.title.split(/[\\/]/).filter(Boolean).pop() ?? n.title : n.title;
        return <span key={n.id}><button class="link" title={n.title} onClick={() => n.kind === "session" && openNodeById(n.id)}>{title}</button><span class="muted"> › </span></span>;
      })}
    </div>
  );
}

/** 标题栏的节点动作：最多显示 3 个，其余放进“⋯”菜单（节点右键菜单列出全部动作）。 */
function HeadActions({ node, actions }: { node: TreeNode; actions: ActionSpec[] }) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const timer = setTimeout(() => addEventListener("click", close));
    return () => { clearTimeout(timer); removeEventListener("click", close); };
  }, [menu]);
  const { shown, more } = splitActions(actions);
  const run = (spec: ActionSpec) => void runAction(node.source, spec.id, { type: "node", nodeId: node.id }, openNodeById);
  return (
    <>
      {shown.map((a) => <button key={a.id} class={"btn small-btn" + (a.danger ? " danger" : "")} data-testid="node-head-action" title={a.confirm} onClick={() => run(a)}>{a.title}</button>)}
      {more.length > 0 && (
        <span class="head-more">
          <button class="chip-btn" data-testid="head-more" title="更多动作" onClick={() => setMenu(!menu)}>⋯</button>
          {menu && <div class="menu head-menu" data-testid="head-menu">{more.map((a) => (
            <button key={a.id} class={"menu-item" + (a.danger ? " danger" : "")} data-testid="head-menu-action" onClick={() => { setMenu(false); run(a); }}>{a.title}</button>
          ))}</div>}
        </span>
      )}
    </>
  );
}

/**
 * 插件会话输入框里尚未提交的文字，按节点保存在本标签页内存中：切换节点再回来时还在，
 * 提交失败时即使已切换到其他节点也能放回原节点。
 */
const drafts = new Store<Record<string, string>>({});
const setDraft = (nodeId: string, update: (value: string) => string) => drafts.set((all) => ({ ...all, [nodeId]: update(all[nodeId] ?? "") }));

function PluginComposer({ node, running }: { node: TreeNode; running: boolean }) {
  const text = useStore(drafts)[node.id] ?? "";
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const composer = node.composer;
  const action = composer && actionSpec(node.source, composer.actionId);
  // 停止的语义是取消：清出的待发文本按原顺序放回输入框。
  const stop = async () => { const cleared = await abortPlugin(); if (cleared?.length) setDraft(node.id, (value) => [...cleared, value].filter(Boolean).join("\n")); };
  /**
   * 提交即清空：文字移出输入框后发出请求，等待期间输入框可以继续输入；确定没有执行（被拒、放弃了附带的表单）
   * 或浏览器侧结果未知（断网）时，按原样放回到期间新写的内容之前。插件返回处理中（含服务端调用超时）时
   * 文字不放回，留下“查询结果”；之后查到没有执行时再放回。
   */
  const submit = async () => {
    const value = text.trim(); if (!value || busy) return;
    if (composer && !action) { toast("插件没有声明输入框使用的动作", "error"); return; }
    setDraft(node.id, () => ""); setBusy(true);
    // 文字最多放回一次：当场确定没有执行或结果未知时放回；处理中的动作之后查询到没有执行时放回。
    let restored = false;
    const restore = () => { if (restored) return; restored = true; setDraft(node.id, (current) => restoreText(value, current)); };
    let outcome: string;
    try {
      // 有 composer 时改为调用指定动作，文字放在 input.fields.message；不弹确认，也不取附带表单。
      outcome = action
        ? await invokeAction(action, { type: "node", nodeId: node.id }, { answers: [], fields: { message: value } }, openNodeById, restore)
        : await sendToPlugin(value, running ? delivery : undefined);
    } catch (error) { toast((error as Error).message, "error"); outcome = "failed"; }
    finally { setBusy(false); }
    if (outcome === "failed" || outcome === "abandoned" || outcome === "unknown") restore();
  };
  return (
    <div class="composer-wrap" data-testid="plugin-composer">
      {action && <div class="composer-hint">发送的文字作为“{action.title}”提交给 {pluginName(node.source)}{running ? "，不中断当前运行" : ""}</div>}
      <div class="composer">
        <textarea class="editor plain-editor" data-testid="plugin-editor" rows={2} value={text} placeholder={composer?.placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"}
          aria-busy={busy ? "true" : undefined}
          onInput={(e) => { const value = e.currentTarget.value; setDraft(node.id, () => value); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } }} />
        <div class="composer-actions">
          {!composer && running && (
            <select class="chip-btn" value={delivery} onChange={(e) => setDelivery(e.currentTarget.value as "steer" | "followUp")} title="运行中发送的方式">
              <option value="steer">插话（steer）</option><option value="followUp">排队（follow-up）</option>
            </select>
          )}
          <span class="spacer" />
          {/* 节点声明了 abort 就提供停止（如排队等名额、还没有运行进程的任务）；没有可停止的运行时插件返回 nothingToStop。 */}
          {node.capabilities.includes("abort") && <button class="btn danger" data-testid="plugin-stop" title="取消当前运行并清空队列" onClick={() => void stop()}>停止</button>}
          <button class="btn primary" data-testid="plugin-send" disabled={!text.trim() || busy} onClick={() => void submit()}>发送</button>
        </div>
      </div>
    </div>
  );
}

export function PluginSessionView() {
  const view = useStore(pluginView)!;
  useStore(trees);
  const formMap = useStore(forms);
  const prefs = useStore(settings);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const node = findNode(view.nodeId);
  const panels = useNodePanels(node);
  const details = useDetails(view.nodeId);
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
  const capabilities = node?.capabilities.join(" ");
  useEffect(() => { if (node) syncCapabilities(node); }, [capabilities]);
  if (!node) return <div class="placeholder">该节点已不在会话列表中。</div>;
  const pending = sortedForms(formMap.values()).filter((f) => f.nodeId === node.id);
  const status = model?.view.status ?? node.status;
  const phase = inFlight?.phase ?? "idle";
  const running = status === "running" || phase !== "idle";
  const actions = nodeActions(node);
  const readonly = model ? model.view.readonly : !node.capabilities.includes("send");
  const canSend = node.capabilities.includes("send") && !readonly && !view.closed;
  const canAbort = node.capabilities.includes("abort");
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
        <HeadActions node={node} actions={actions} />
        {node.kind === "session" && panels.length > 0 && <DetailsButton details={details} />}
      </div>
    </div>
  );
  if (node.kind !== "session") {
    return <div class="main-split"><div class="chat" data-testid="plugin-node">{head}{pendingBanner}<NodePanels node={node} panels={panels} onOpenNode={openNodeById} /></div></div>;
  }
  const readonlyText = view.closed ? "插件没有提供该会话的内容"
    : READONLY_TEXT[model?.view.readonlyReason ?? ""] ?? (node.availability === "archived" ? "会话已存档" : "没有向该会话发消息的权限");
  return (
    <div class="main-split">
      <div class="chat" data-testid="plugin-session" data-node-id={node.id}>
        {head}
        {pendingBanner}
        {(status === "failed" || status === "interrupted") && node.statusDetail && <div class="banner error">{STATUS_TEXT[status]}：{node.statusDetail}</div>}
        {view.error && <div class="banner error" data-testid="plugin-error">{view.error}</div>}
        <div class="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {view.loading && <div class="muted pad">加载中…</div>}
          {view.closed && <div class="empty-chat" data-testid="plugin-closed">插件没有提供该会话的内容，只能查看节点信息和面板。</div>}
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
        {canSend ? <PluginComposer key={node.id} node={node} running={running} /> : (
          <div class="readonly-bar" data-testid="plugin-readonly">
            <span data-testid="plugin-readonly-reason">只读：{readonlyText}</span>
            {canAbort && !view.closed && <button class="btn danger small-btn" data-testid="plugin-stop" title="取消当前运行并清空队列" onClick={() => void stop()}>停止</button>}
          </div>
        )}
        <div class="statusbar">{node.statusDetail && <span>{node.statusDetail}</span>}<span>来源：{pluginName(node.source)}</span></div>
      </div>
      {details.shown && <NodePanels node={node} panels={panels} onClose={details.close} drawer={details.narrow} onOpenNode={openNodeById} />}
    </div>
  );
}
