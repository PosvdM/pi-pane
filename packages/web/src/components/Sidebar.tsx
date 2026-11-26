// 侧栏：待处理区、主会话与插件节点合并的会话树、侧栏面板（architecture.md“会话列表”，plugin-api.md“会话树”“持久表单”“面板”）。
// 列表由服务端推送的会话树驱动：主会话树（source = "pane"）的变更经 WebSocket 推来，不依赖当前会话的事件。
import { useEffect, useRef, useState } from "preact/hooks";
import { sidebarOpen } from "../lib/actions.ts";
import { nodeLabel, openFromResult, openNode, openNodeById } from "../lib/navigate.ts";
import { closePluginView, pluginView } from "../lib/plugin-session.ts";
import { clampSidebar, SIDEBAR_MAX, SIDEBAR_MIN } from "../lib/plugin-state.ts";
import { formBusy, formKey, forms, openForm, panelKey, panelState, runAction, sortedForms } from "../lib/plugin-ui.ts";
import { actionSpec, pluginName, plugins } from "../lib/plugins.ts";
import { current, openFile } from "../lib/session.ts";
import { useStore } from "../lib/store.ts";
import { awaitingParent, findNode, loadChildren, reloadAll, treeStatus, trees } from "../lib/tree.ts";
import { childrenAcross, hiddenChildren, orphanHistory, unassigned } from "../lib/tree-state.ts";
import { overlay } from "../lib/ui-state.ts";
import type { SourceTree } from "../lib/tree-state.ts";
import type { FormSpec, NodeStatus, PaneSessionNodeInfo, TreeNode } from "../lib/types.ts";
import { panelBadge, PanelView, useNodePanels } from "./Panels.tsx";

export function when(iso: string | undefined): string {
  const time = iso ? Date.parse(iso) : NaN; if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(time).toLocaleDateString("zh-CN");
}
export function expiresIn(iso?: string): string | null {
  const time = iso ? Date.parse(iso) : NaN; if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.round((time - Date.now()) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时后过期` : `${minutes} 分钟后过期`;
}

export const STATUS_TEXT: Record<NodeStatus, string> = {
  idle: "空闲", running: "运行中", waiting: "等待中", paused: "已暂停", done: "已完成", failed: "失败", stopped: "已停止", interrupted: "已中断",
};
const STATUS_ICON: Record<NodeStatus, string> = { idle: "○", running: "●", waiting: "◔", paused: "‖", done: "✓", failed: "✕", stopped: "■", interrupted: "!" };
export function StatusIcon({ status }: { status: NodeStatus }) {
  return <span class={"node-status ns-" + status} aria-label={STATUS_TEXT[status]}>{STATUS_ICON[status]}</span>;
}

export function nodeTitle(id: string): string { const node = findNode(id); return node ? nodeLabel(node) : id; }

/** 节点右键菜单：节点 capabilities 中列出、scope 含 node 的动作。 */
interface Menu { x: number; y: number; node: TreeNode }
export function nodeActions(node: TreeNode) {
  return node.capabilities.filter((c) => c.startsWith("action:")).map((c) => actionSpec(node.source, c.slice(7))).filter((spec) => !!spec && spec.scope.includes("node")).map((spec) => spec!);
}

interface Ctx {
  activeId: string | null;
  pending: Map<string, number>;
  allTrees: Map<string, SourceTree>;
  setMenu: (menu: Menu | null) => void;
}

/** 节点下的子节点（来自所有来源）与未加载的“历史”。ancestors 防止循环引用导致无限展开。 */
function NodeRow({ node, depth, ctx, ancestors = new Set() }: { node: TreeNode; depth: number; ctx: Ctx; ancestors?: Set<string> }) {
  const kids = childrenAcross(ctx.allTrees, node.id).filter((child) => !ancestors.has(child.id) && child.id !== node.id && !unassigned(ctx.allTrees, child, awaitingParent));
  const history = hiddenChildren(ctx.allTrees, node);
  const hidden = history.count;
  const expandable = kids.length > 0 || hidden > 0 || history.unknown;
  const path = new Set(ancestors).add(node.id);
  const [open, setOpen] = useState(node.source !== "pane" || kids.some((k) => ["running", "waiting", "paused"].includes(k.status)));
  const pending = ctx.pending.get(node.id) ?? 0;
  const info = (node as TreeNode & { paneSession?: PaneSessionNodeInfo }).paneSession;
  const main = node.source === "pane";
  const tip = [nodeLabel(node), `${STATUS_TEXT[node.status]}${node.statusDetail ? "：" + node.statusDetail : ""}`,
    node.availability === "archived" && !main ? "已存档，只能查看" : "", info?.sessionFile ?? ""].filter(Boolean).join("\n");
  const indent = main ? 6 : 6 + depth * 14;
  // 点击：会话打开会话视图；分组展开或折叠，有适用的节点面板时同时打开；资源打开适用的面板（plugin-api.md“显示规则”）。
  const nodePanels = useNodePanels(main ? undefined : node);
  const click = () => {
    if (node.kind === "session") { openNode(node); return; }
    if (node.kind === "group") setOpen(!open);
    if (node.kind === "resource" || nodePanels.length) openNode(node);
  };
  return (
    <>
      <div class={"tree-row" + (main ? " main-row session-item" : "") + (ctx.activeId === node.id ? " active" : "") + " av-" + node.availability}
        style={{ paddingLeft: `${indent}px` }} title={tip} data-testid={main ? "session-item" : "tree-node"} data-node-id={node.id}
        {...(info ? { "data-session-file": info.sessionFile } : {})}
        onClick={click}
        onContextMenu={(e) => { if (main) return; e.preventDefault(); ctx.setMenu({ x: e.clientX, y: e.clientY, node }); }}>
        <button class="twisty" data-testid="twisty" style={{ visibility: expandable ? "visible" : "hidden" }} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? "▾" : "▸"}</button>
        {main ? <span class={"status-dot s-" + (node.availability === "online" ? node.status : "none")} /> : <StatusIcon status={node.status} />}
        <span class="session-label">{nodeLabel(node)}</span>
        {node.availability === "missing" && <span class="muted small" data-testid="node-missing">存档缺失</span>}
        {node.badge && <span class="node-badge">{node.badge}</span>}
        {main && !open && expandable && <span class="node-badge" data-testid="child-count">{history.unknown ? "有子节点" : `${kids.length + hidden} 个子节点`}</span>}
        {pending > 0 && <span class="pending-dot" data-testid="node-pending" title={`${pending} 项待处理`}>{pending}</span>}
        {main ? <span class="session-meta">{when(info?.modifiedAt)} · {node.messageCount ?? 0}</span>
          : node.messageCount != null && node.messageCount > 0 && <span class="session-meta">{node.messageCount}</span>}
      </div>
      {open && kids.map((child) => <NodeRow key={child.id} node={child} depth={depth + 1} ctx={ctx} ancestors={path} />)}
      {open && (hidden > 0 || history.unknown) && <button class="link history tree-history" data-testid="node-history" style={{ marginLeft: `${26 + (depth + 1) * 14}px` }}
        onClick={() => { for (const source of history.sources) void loadChildren(source, node.id); }}>{history.unknown ? "历史" : `历史（${hidden}）`}</button>}
    </>
  );
}

/** 主会话只显示已写入存储、已有消息或当前打开的；尚未写入的空会话不占位置。 */
function visibleMain(node: TreeNode, activeId: string | null): boolean {
  const info = (node as TreeNode & { paneSession?: PaneSessionNodeInfo }).paneSession;
  return node.kind === "session" && (!info || info.stored || (node.messageCount ?? 0) > 0 || node.id === activeId);
}

/**
 * 项目分组：主会话和插件挂在该分组下的节点合并，按 sortKey 统一排序。未加载的部分合成一行“历史（N）”：
 * 主会话按分组的 childCount 扣除已加载的会话，插件按快照报告的 foreignChildCounts（见 hiddenChildren）。
 */
function Project({ group, ctx }: { group: TreeNode; ctx: Ctx }) {
  const rows = childrenAcross(ctx.allTrees, group.id)
    .filter((n) => n.source === "pane" ? visibleMain(n, ctx.activeId) : !unassigned(ctx.allTrees, n, awaitingParent));
  const history = hiddenChildren(ctx.allTrees, group);
  const name = group.title.split(/[\\/]/).filter(Boolean).pop() ?? group.title;
  if (!rows.length && !history.count && !history.unknown) return null;
  return (
    <div class="project" data-testid="project" data-project-id={group.id}>
      <div class="project-head" title={group.title}>
        <span class="project-name">{name}</span>
        <button class="icon-btn" title="在此项目新建会话" data-testid="new-in-project" onClick={() => { closePluginView(); void openFile(group.title); }}>＋</button>
      </div>
      {rows.map((node) => <NodeRow key={node.id} node={node} depth={0} ctx={ctx} />)}
      {(history.count > 0 || history.unknown) && <button class="link history" data-testid="project-history"
        onClick={() => { for (const source of history.sources) void loadChildren(source, group.id); }}>{history.unknown ? "历史" : `历史（${history.count}）`}</button>}
    </div>
  );
}

/** 待处理区：所有插件的持久表单，按插件分组，组内按 (createdAt, id) 升序。 */
function Pending() {
  const map = useStore(forms);
  const busy = useStore(formBusy);
  useStore(plugins);
  const [open, setOpen] = useState(true);
  const list = sortedForms(map.values());
  if (!list.length) return null;
  const groups = new Map<string, FormSpec[]>();
  for (const form of list) groups.set(form.source, [...(groups.get(form.source) ?? []), form]);
  return (
    <section class="pending" data-testid="pending">
      <button class="pending-head" onClick={() => setOpen(!open)}>
        <span class="twisty-static">{open ? "▾" : "▸"}</span>
        <span>待处理</span>
        <span class="count-badge" data-testid="pending-count">{list.length}</span>
      </button>
      {open && [...groups.entries()].map(([source, items]) => (
        <div key={source} class="pending-group">
          <div class="pending-source">{pluginName(source)}</div>
          {items.map((form) => {
            const key = formKey(form.source, form.id); const state = busy[key];
            return (
              <button key={key} class="pending-item" data-testid="pending-item" data-form-id={form.id} title={form.title}
                onClick={() => openForm.set({ key, persistent: true, form })}>
                <span class="pending-title">{form.title}</span>
                <span class="pending-meta">
                  {state ? <span class="busy">{state.state === "unknown" ? "结果未知" : state.state === "submitting" ? "提交中" : state.message ?? "处理中"}</span> : <>
                    {when(form.createdAt)}
                    {expiresIn(form.expiresAt) && <> · <span class="expiry">{expiresIn(form.expiresAt)}</span></>}
                    {form.nodeId && <> · {nodeTitle(form.nodeId)}</>}
                  </>}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}

function SidebarPanels() {
  const state = useStore(plugins);
  const badges = useStore(panelState);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const panels = Object.values(state.catalogs).flatMap((c) => c.panels).filter((p) => p.placement === "sidebar");
  if (!panels.length) return null;
  return (
    <div class="side-panels">
      {panels.map((panel) => {
        const key = panelKey(panel.source, panel.id); const badge = panelBadge(panel, badges); const shown = open[key];
        return (
          <section key={key} class="side-panel" data-testid="side-panel">
            <button class="pending-head" onClick={() => setOpen({ ...open, [key]: !shown })}>
              <span class="twisty-static">{shown ? "▾" : "▸"}</span><span>{panel.title}</span>
              {badge ? <span class="count-badge">{badge}</span> : null}
            </button>
            {shown && <div class="panel-body"><PanelView panel={panel} onOpenNode={openNodeById} /></div>}
          </section>
        );
      })}
    </div>
  );
}

function NodeMenu({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const actions = nodeActions(menu.node);
  useEffect(() => {
    const close = () => onClose();
    addEventListener("click", close); addEventListener("blur", close);
    return () => { removeEventListener("click", close); removeEventListener("blur", close); };
  }, []);
  return (
    <div class="menu" data-testid="node-menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
      {menu.node.kind === "session" ? <button class="menu-item" onClick={() => openNode(menu.node)}>打开</button>
        : <button class="menu-item" data-testid="node-detail" onClick={() => openNode(menu.node)}>查看详情</button>}
      {actions.map((spec) => <button key={spec.id} class={"menu-item" + (spec.danger ? " danger" : "")} data-testid="node-action"
        onClick={() => void runAction(menu.node.source, spec.id, { type: "node", nodeId: menu.node.id }, openFromResult())}>{spec.title}</button>)}
    </div>
  );
}

function AddMenu({ onClose }: { onClose: () => void }) {
  const state = useStore(plugins);
  const globals = Object.values(state.catalogs).flatMap((c) => c.actions).filter((a) => a.scope.includes("global"));
  useEffect(() => {
    const close = () => onClose();
    setTimeout(() => addEventListener("click", close));
    return () => removeEventListener("click", close);
  }, []);
  return (
    <div class="menu add-menu" data-testid="add-menu">
      <button class="menu-item" onClick={() => overlay.set("new-session")}>新建会话</button>
      {globals.map((spec) => <button key={spec.source + spec.id} class={"menu-item" + (spec.danger ? " danger" : "")} data-testid="global-action"
        onClick={() => void runAction(spec.source, spec.id, { type: "global" }, openFromResult())}>{spec.title}<span class="src-tag">{pluginName(spec.source)}</span></button>)}
    </div>
  );
}

const WIDTH_KEY = "pi-pane.sidebarWidth";
/** 与 style.css 中侧栏变为浮层的断点一致。 */
const NARROW_SIDEBAR = "(max-width: 760px)";
/** 侧栏宽度按浏览器记住，范围 240–480px，默认 280px。 */
export function sidebarWidth(): number {
  const stored = localStorage.getItem(WIDTH_KEY);
  return clampSidebar(stored === null ? NaN : Number(stored));
}
function Resizer() {
  const dragging = useRef(false);
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", sidebarWidth() + "px");
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      // 窄屏下侧栏是固定 280px 的浮层，拖动不改变宽度，也不改保存值（手柄在窄屏隐藏）。
      if (matchMedia(NARROW_SIDEBAR).matches) return;
      const width = clampSidebar(e.clientX);
      document.documentElement.style.setProperty("--sidebar-w", width + "px");
      localStorage.setItem(WIDTH_KEY, String(width));
    };
    const up = () => { dragging.current = false; document.body.classList.remove("resizing"); };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
    return () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); };
  }, []);
  return <div class="sidebar-resizer" data-testid="sidebar-resizer" title={`拖动调整宽度（${SIDEBAR_MIN}–${SIDEBAR_MAX}px）`} onPointerDown={(e) => { e.preventDefault(); dragging.current = true; document.body.classList.add("resizing"); }} />;
}

export function Sidebar() {
  const allTrees = useStore(trees);
  const status = useStore(treeStatus);
  const sidebar = useStore(sidebarOpen);
  const state = useStore(current);
  const view = useStore(pluginView);
  const formMap = useStore(forms);
  useStore(plugins);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [adding, setAdding] = useState(false);
  const activeId = view ? view.nodeId : state?.id ? "pane:session:" + state.id : null;
  // 表单 Map 原地修改，每次渲染重新统计。
  const pending = new Map<string, number>();
  for (const form of formMap.values()) if (form.nodeId) pending.set(form.nodeId, (pending.get(form.nodeId) ?? 0) + 1);
  const ctx: Ctx = { activeId, pending, allTrees, setMenu };
  const pane = allTrees.get("pane");
  const projects = pane ? pane.children(null).filter((n) => n.id.startsWith("pane:project:")).sort((a, b) => {
    // 项目按其中最新会话的修改时间排列。
    const top = (g: TreeNode) => pane.children(g.id)[0]?.sortKey ?? "~";
    return top(a) < top(b) ? -1 : top(a) > top(b) ? 1 : 0;
  }) : [];
  // 父节点不存在（所在来源已加载却没有它，或来源不在）、指向“未归属”或形成循环的插件节点归入“未归属”。
  const orphans: TreeNode[] = []; const roots = new Map<string, TreeNode[]>();
  for (const [source, t] of allTrees) {
    if (source === "pane") continue;
    for (const node of t.children(null)) roots.set(source, [...(roots.get(source) ?? []), node]);
    for (const node of t.nodes.values()) if (unassigned(allTrees, node, awaitingParent)) orphans.push(node);
  }
  // 报告了子节点数、但父节点不在任何来源里：这些冷节点也属于“未归属”，与普通父节点同一规则（分页游标优先）。
  const orphanMore = orphanHistory(allTrees, (parent) => {
    if (awaitingParent(parent)) return true;
    const parentTree = allTrees.get(parent.slice(0, parent.indexOf(":")));
    return !!parentTree && !parentTree.epoch;
  });
  const loadOrphans = () => { for (const [source, parent] of orphanMore.parents) void loadChildren(source, parent); };
  const errors = Object.entries(status).filter(([, s]) => s.error);
  const loading = Object.values(status).some((s) => s.loading);
  const empty = !projects.some((g) => childrenAcross(allTrees, g.id).length > 0 || (g.childCount ?? 0) > 0) && !roots.size && !orphans.length;
  return (
    <aside class={"sidebar" + (sidebar ? "" : " closed")} data-testid="sidebar">
      <div class="sidebar-head">
        <span class="brand">pi-pane</span>
        <span class="spacer" />
        <button class="icon-btn" title="新建" data-testid="add-menu-btn" onClick={() => setAdding(!adding)}>＋</button>
        <button class="icon-btn" title="刷新会话列表" data-testid="refresh-tree" onClick={() => reloadAll()}>⟳</button>
        <button class="icon-btn" title="设置" data-testid="open-settings" onClick={() => overlay.set("settings")}>⚙</button>
        {adding && <AddMenu onClose={() => setAdding(false)} />}
      </div>
      <button class="btn primary wide" data-testid="new-session" onClick={() => overlay.set("new-session")}>新建会话</button>
      <Pending />
      <div class="session-list" data-testid="session-list">
        {errors.map(([source, s]) => <div key={source} class="error-text pad" data-testid="tree-error">{source === "pane" ? "" : pluginName(source) + "："}{s.error}</div>)}
        {empty && !loading && !errors.length && <div class="muted pad">还没有会话。</div>}
        {projects.map((group) => <Project key={group.id} group={group} ctx={ctx} />)}
        {[...roots.entries()].map(([source, nodes]) => (
          <div key={source} class="project" data-testid="plugin-roots">
            <div class="project-head" title={`${pluginName(source)} 的节点`}><span class="project-name">{pluginName(source)}</span></div>
            {nodes.map((node) => <NodeRow key={node.id} node={node} depth={0} ctx={ctx} />)}
          </div>
        ))}
        {(orphans.length > 0 || orphanMore.count > 0 || orphanMore.unknown) && (
          <div class="project" data-testid="unassigned">
            <div class="project-head" title="所属主会话已不在列表中的插件节点"><span class="project-name">未归属</span></div>
            {orphans.map((node) => <NodeRow key={node.id} node={node} depth={0} ctx={ctx} />)}
            {(orphanMore.count > 0 || orphanMore.unknown) && <button class="link history" data-testid="unassigned-history" onClick={loadOrphans}>{orphanMore.count > 0 ? `历史（${orphanMore.count}）` : "历史"}</button>}
          </div>
        )}
      </div>
      <SidebarPanels />
      {menu && <NodeMenu menu={menu} onClose={() => setMenu(null)} />}
      <Resizer />
    </aside>
  );
}
