// 插件面板：按 PanelContent 的类型用内置组件渲染，内容按需拉取，收到 panelChanged 后重新拉取（plugin-api.md“面板”）。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { panelState, runAction } from "../lib/plugin-ui.ts";
import { actionSpec } from "../lib/plugins.ts";
import { useStore } from "../lib/store.ts";
import type { PanelContent, PanelSpec, TreeNode } from "../lib/types.ts";
import { Markdown } from "./Message.tsx";

/** 适用于节点的 node 面板：没有 appliesTo 时适用于该插件自己的全部节点。 */
export function panelsFor(node: TreeNode, panels: PanelSpec[]): PanelSpec[] {
  return panels.filter((panel) => {
    if (panel.placement !== "node") return false;
    const rule = panel.appliesTo;
    if (!rule) return panel.source === node.source;
    if (rule.kinds && !rule.kinds.includes(node.kind)) return false;
    if (rule.sources && !rule.sources.includes(node.source)) return false;
    if (rule.resourceTypes && !(node.resourceRef && rule.resourceTypes.includes(node.resourceRef.type))) return false;
    return true;
  });
}

function RowActions({ source, panelId, rowId, nodeId, actions, onOpenNode }: { source: string; panelId: string; rowId: string; nodeId?: string; actions?: string[]; onOpenNode: (id: string) => void }) {
  const specs = (actions ?? []).map((id) => actionSpec(source, id)).filter((spec) => spec?.scope.includes("panelRow"));
  if (!specs.length) return null;
  return (
    <span class="row-actions" onClick={(e) => e.stopPropagation()}>
      {specs.map((spec) => <button key={spec!.id} class={"btn small-btn" + (spec!.danger ? " danger" : "")} data-testid="panel-row-action"
        onClick={() => void runAction(source, spec!.id, { type: "panelRow", panelId, rowId, ...(nodeId ? { nodeId } : {}) }, onOpenNode)}>{spec!.title}</button>)}
    </span>
  );
}

export function PanelBody({ panel, content, onOpenNode }: { panel: PanelSpec; content: PanelContent; onOpenNode: (id: string) => void }) {
  switch (content.type) {
    case "markdown": return <Markdown text={content.markdown} />;
    case "keyValue": return (
      <table class="kv panel-kv"><tbody>{content.rows.map((row, i) => <tr key={i}><th>{row.key}</th><td>{row.value}</td></tr>)}</tbody></table>
    );
    case "table": return (
      <table class="kv panel-table">
        <thead><tr>{content.columns.map((c) => <th key={c.key}>{c.title}</th>)}<th /></tr></thead>
        <tbody>{content.rows.map((row) => (
          <tr key={row.rowId} class={row.nodeId ? "clickable" : ""} onClick={() => row.nodeId && onOpenNode(row.nodeId)}>
            {content.columns.map((c) => <td key={c.key}>{row.cells[c.key] ?? ""}</td>)}
            <td><RowActions source={panel.source} panelId={panel.id} rowId={row.rowId} nodeId={row.nodeId} actions={row.actions} onOpenNode={onOpenNode} /></td>
          </tr>
        ))}</tbody>
      </table>
    );
    case "list": return (
      <div class="panel-list">{content.items.map((item) => (
        <div key={item.id} class={"panel-item" + (item.nodeId ? " clickable" : "")} onClick={() => item.nodeId && onOpenNode(item.nodeId)}>
          <div class="panel-item-head"><span class="session-label">{item.title}</span>{item.badge && <span class="node-badge">{item.badge}</span>}</div>
          {item.subtitle && <div class="muted small">{item.subtitle}</div>}
          <RowActions source={panel.source} panelId={panel.id} rowId={item.id} nodeId={item.nodeId} actions={item.actions} onOpenNode={onOpenNode} />
        </div>
      ))}</div>
    );
    default: return <div class="muted" data-testid="panel-unsupported">此面板需要更新的 pi-pane</div>;
  }
}

/** 拉取并显示一个面板；面板修订号变化且影响本节点（或全部）时重新拉取。 */
export function PanelView({ panel, nodeId, onOpenNode }: { panel: PanelSpec; nodeId?: string; onOpenNode: (id: string) => void }) {
  const state = useStore(panelState)[panel.id];
  const [content, setContent] = useState<PanelContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 只影响其他节点的变更不触发重新拉取：沿用上次拉取时的修订号。
  const fetched = useRef(0);
  const affects = !state?.nodeId || !nodeId || state.nodeId === nodeId;
  const revision = affects ? state?.revision ?? 0 : fetched.current;
  useEffect(() => {
    fetched.current = revision;
    let live = true;
    const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "";
    api<PanelContent>(`/api/plugins/${encodeURIComponent(panel.source)}/panels/${encodeURIComponent(panel.id)}${query}`)
      .then((value) => { if (live) { setContent(value); setError(null); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [panel.id, panel.source, nodeId, revision]);
  if (error) return <div class="error-text" data-testid="panel-error">{error}</div>;
  if (!content) return <div class="muted">加载中…</div>;
  return <PanelBody panel={panel} content={content} onOpenNode={onOpenNode} />;
}

/** 面板角标：panelChanged 带来的值优先，否则用 PanelSpec 的初始值。 */
export function panelBadge(panel: PanelSpec, state: Record<string, { badgeCount?: number | null }>): number | null {
  const value = state[panel.id]?.badgeCount;
  return value === undefined ? panel.badgeCount ?? null : value;
}
