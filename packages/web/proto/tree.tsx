// 侧栏：待处理区 + 主会话与插件节点合并的会话树（plugin-api.md“会话树”“持久表单”）。
import { useState } from "preact/hooks";
import type { FormSpec, NodeStatus, TreeNode } from "@pi-pane/plugin-api";
import { FORMS, MAIN_SESSIONS, NOW, PARENT_TOTALS, PLUGIN_NODES, type MainSession } from "./data.ts";

export function when(iso: string): string {
  const diff = NOW - Date.parse(iso);
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
export function left(iso?: string): string | null {
  if (!iso) return null;
  const minutes = Math.max(0, Math.round((Date.parse(iso) - NOW) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时后过期` : `${minutes} 分钟后过期`;
}

export const STATUS_TEXT: Record<NodeStatus, string> = {
  idle: "空闲", running: "运行中", waiting: "等待中", paused: "已暂停", done: "已完成", failed: "失败", stopped: "已停止", interrupted: "已中断",
};
const STATUS_ICON: Record<NodeStatus, string> = {
  idle: "○", running: "●", waiting: "◔", paused: "‖", done: "✓", failed: "✕", stopped: "■", interrupted: "!",
};
export function StatusIcon({ status }: { status: NodeStatus }) {
  return <span class={"node-status ns-" + status} aria-label={STATUS_TEXT[status]}>{STATUS_ICON[status]}</span>;
}

export function nodeTitle(id: string): string {
  if (id.startsWith("pane:session:")) return MAIN_SESSIONS.find((s) => "pane:session:" + s.id === id)?.title ?? id;
  return PLUGIN_NODES.find((n) => n.id === id)?.title ?? id;
}
const children = (parentId: string) => PLUGIN_NODES.filter((n) => n.parentId === parentId).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
const pendingFor = (nodeId: string, forms: FormSpec[]) => forms.filter((f) => f.nodeId === nodeId).length;

interface TreeProps { active: string; onOpen: (id: string) => void; forms: FormSpec[]; busyForm?: string; onForm: (form: FormSpec) => void }

function NodeRow({ node, depth, props }: { node: TreeNode; depth: number; props: TreeProps }) {
  const kids = children(node.id);
  const [open, setOpen] = useState(kids.length > 0 && node.kind === "session");
  const pending = pendingFor(node.id, props.forms);
  const hidden = (node.childCount ?? 0) - kids.length;
  const tip = [node.title, `${STATUS_TEXT[node.status]}${node.statusDetail ? "：" + node.statusDetail : ""}`, node.availability === "archived" ? "已存档，只能查看" : ""].filter(Boolean).join("\n");
  return (
    <>
      <div class={"tree-row" + (props.active === node.id ? " active" : "") + " av-" + node.availability} style={{ paddingLeft: `${6 + depth * 14}px` }} title={tip}
        onClick={() => node.kind === "session" ? props.onOpen(node.id) : setOpen(!open)}>
        <button class="twisty" style={{ visibility: node.hasChildren ? "visible" : "hidden" }} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? "▾" : "▸"}</button>
        <StatusIcon status={node.status} />
        <span class="session-label">{node.title}</span>
        {node.badge && <span class="node-badge">{node.badge}</span>}
        {pending > 0 && <span class="pending-dot" title={`${pending} 项待处理`}>{pending}</span>}
        {node.messageCount != null && node.messageCount > 0 && <span class="session-meta">{node.messageCount}</span>}
      </div>
      {open && kids.map((child) => <NodeRow key={child.id} node={child} depth={depth + 1} props={props} />)}
      {open && hidden > 0 && <button class="link history tree-history" style={{ marginLeft: `${26 + (depth + 1) * 14}px` }}>历史（{hidden}）</button>}
    </>
  );
}

function MainRow({ session, props }: { session: MainSession; props: TreeProps }) {
  const id = "pane:session:" + session.id;
  const kids = children(id);
  const [open, setOpen] = useState(kids.length > 0);
  const hidden = (PARENT_TOTALS[id] ?? kids.length) - kids.length;
  return (
    <>
      <div class={"tree-row main-row" + (props.active === id ? " active" : "")} title={session.title} onClick={() => props.onOpen(id)}>
        <button class="twisty" style={{ visibility: kids.length ? "visible" : "hidden" }} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? "▾" : "▸"}</button>
        <span class={"status-dot s-" + (session.status ?? "none")} />
        <span class="session-label">{session.title}</span>
        {!open && kids.length > 0 && <span class="node-badge">{kids.length} 个子节点</span>}
        <span class="session-meta">{when(session.modifiedAt)} · {session.messageCount}</span>
      </div>
      {open && kids.map((child) => <NodeRow key={child.id} node={child} depth={1} props={props} />)}
      {open && hidden > 0 && <button class="link history tree-history" style={{ marginLeft: "40px" }}>历史（{hidden}）</button>}
    </>
  );
}

/** 待处理区：所有插件的持久表单，按插件分组，组内按 (createdAt, id) 升序。 */
function Pending(props: TreeProps) {
  const [open, setOpen] = useState(true);
  const forms = [...props.forms].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!forms.length) return null;
  const groups = new Map<string, FormSpec[]>();
  for (const form of forms) groups.set(form.source, [...(groups.get(form.source) ?? []), form]);
  return (
    <section class="pending" data-testid="pending">
      <button class="pending-head" onClick={() => setOpen(!open)}>
        <span class="twisty-static">{open ? "▾" : "▸"}</span>
        <span>待处理</span>
        <span class="count-badge">{forms.length}</span>
      </button>
      {open && [...groups.entries()].map(([source, list]) => (
        <div key={source} class="pending-group">
          <div class="pending-source">{source}</div>
          {list.map((form) => (
            <button key={form.id} class="pending-item" onClick={() => props.onForm(form)} title={form.title}>
              <span class="pending-title">{form.title}</span>
              <span class="pending-meta">
                {props.busyForm === form.id ? <span class="busy">处理中 · 等待确认</span> : <>
                  {when(form.createdAt)}
                  {left(form.expiresAt) && <> · <span class="expiry">{left(form.expiresAt)}</span></>}
                  {form.nodeId && <> · {nodeTitle(form.nodeId)}</>}
                </>}
              </span>
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}

export function ProtoSidebar(props: TreeProps) {
  const projects = new Map<string, MainSession[]>();
  for (const s of MAIN_SESSIONS) projects.set(s.cwd, [...(projects.get(s.cwd) ?? []), s]);
  const roots = PLUGIN_NODES.filter((n) => n.parentId === null);
  return (
    <aside class="sidebar" data-testid="sidebar">
      <div class="sidebar-head">
        <span class="brand">pi-pane</span>
        <span class="spacer" />
        <button class="icon-btn" title="新建：会话、子代理任务、会议">＋</button>
        <button class="icon-btn" title="刷新会话列表">⟳</button>
        <button class="icon-btn" title="设置">⚙</button>
      </div>
      <button class="btn primary wide">新建会话</button>
      <Pending {...props} />
      <div class="session-list">
        {[...projects.entries()].map(([cwd, list]) => (
          <div key={cwd} class="project">
            <div class="project-head" title={cwd}><span class="project-name">{cwd.split("/").pop()}</span><button class="icon-btn" title="在此项目新建会话">＋</button></div>
            {list.map((s) => <MainRow key={s.id} session={s} props={props} />)}
          </div>
        ))}
        <div class="project">
          <div class="project-head" title="没有主会话的插件节点"><span class="project-name">agora</span></div>
          {roots.map((node) => <NodeRow key={node.id} node={node} depth={0} props={props} />)}
        </div>
      </div>
    </aside>
  );
}
