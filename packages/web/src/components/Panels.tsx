// 插件面板：按 PanelContent 的类型用内置组件渲染，内容按需拉取，收到 panelChanged 后重新拉取（plugin-api.md“面板”）。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { panelKey, panelState, runAction } from "../lib/plugin-ui.ts";
import { actionSpec, pluginName, plugins } from "../lib/plugins.ts";
import { Store, useStore } from "../lib/store.ts";
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
          <tr key={row.rowId} class={row.nodeId ? "clickable" : ""} data-testid="panel-row" onClick={() => row.nodeId && onOpenNode(row.nodeId)}>
            {content.columns.map((c) => <td key={c.key}>{row.cells[c.key] ?? ""}</td>)}
            <td><RowActions source={panel.source} panelId={panel.id} rowId={row.rowId} nodeId={row.nodeId} actions={row.actions} onOpenNode={onOpenNode} /></td>
          </tr>
        ))}</tbody>
      </table>
    );
    case "list": return (
      <div class="panel-list">{content.items.map((item) => (
        <div key={item.id} class={"panel-item" + (item.nodeId ? " clickable" : "")} data-testid="panel-row" onClick={() => item.nodeId && onOpenNode(item.nodeId)}>
          <div class="panel-item-head"><span class="session-label">{item.title}</span>{item.badge && <span class="node-badge">{item.badge}</span>}</div>
          {item.subtitle && <div class="muted small">{item.subtitle}</div>}
          <RowActions source={panel.source} panelId={panel.id} rowId={item.id} nodeId={item.nodeId} actions={item.actions} onOpenNode={onOpenNode} />
        </div>
      ))}</div>
    );
    default: return <div class="muted" data-testid="panel-unsupported">此面板需要更新的 pi-pane</div>;
  }
}

/**
 * 拉取并显示一个面板；面板修订号变化且影响本节点（或全部）时重新拉取。
 * 内容记下它属于哪个面板和节点：切换面板后、新内容到达前不显示旧面板的行，行动作也就不会带着新面板的 id 提交旧行。
 */
export function PanelView({ panel, nodeId, onOpenNode }: { panel: PanelSpec; nodeId?: string; onOpenNode: (id: string) => void }) {
  const key = panelKey(panel.source, panel.id);
  const state = useStore(panelState)[key];
  const target = key + "\u0000" + (nodeId ?? "");
  const [content, setContent] = useState<{ target: string; value: PanelContent } | null>(null);
  const [error, setError] = useState<{ target: string; message: string } | null>(null);
  // 只影响其他节点的变更不触发重新拉取：沿用上次拉取时的修订号。
  const fetched = useRef(0);
  const affects = !state?.nodeId || !nodeId || state.nodeId === nodeId;
  const revision = affects ? state?.revision ?? 0 : fetched.current;
  useEffect(() => {
    fetched.current = revision;
    let live = true;
    const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "";
    api<PanelContent>(`/api/plugins/${encodeURIComponent(panel.source)}/panels/${encodeURIComponent(panel.id)}${query}`)
      .then((value) => { if (live) { setContent({ target, value }); setError(null); } })
      .catch((e) => { if (live) setError({ target, message: (e as Error).message }); });
    return () => { live = false; };
  }, [target, revision]);
  if (error?.target === target) return <div class="error-text" data-testid="panel-error">{error.message}</div>;
  if (content?.target !== target) return <div class="muted" data-testid="panel-loading">加载中…</div>;
  return <PanelBody panel={panel} content={content.value} onOpenNode={onOpenNode} />;
}

/** 面板角标：panelChanged 带来的值优先，否则用 PanelSpec 的初始值。 */
export function panelBadge(panel: PanelSpec, state: Record<string, { badgeCount?: number | null }>): number | null {
  const value = state[panelKey(panel.source, panel.id)]?.badgeCount;
  return value === undefined ? panel.badgeCount ?? null : value;
}

/** 适用于该节点的全部 node 面板。 */
export function useNodePanels(node: TreeNode | undefined): PanelSpec[] {
  const state = useStore(plugins);
  return node ? panelsFor(node, Object.values(state.catalogs).flatMap((c) => c.panels)) : [];
}

const DETAILS_KEY = "pi-pane.nodePanel";
/** “详情”开关按浏览器全局记住（localStorage），所有节点共用。 */
export const detailsOpen = new Store<boolean>(globalThis.localStorage?.getItem(DETAILS_KEY) !== "0");
function setDetailsOpen(open: boolean): void { detailsOpen.set(open); localStorage.setItem(DETAILS_KEY, open ? "1" : "0"); }

/** 视口宽度小于 1100px 时节点面板改为从右侧滑出的抽屉，覆盖在会话视图上。 */
export const NARROW_QUERY = "(max-width: 1099px)";
function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query); const update = () => setMatch(list.matches);
    list.addEventListener("change", update); update();
    return () => list.removeEventListener("change", update);
  }, [query]);
  return match;
}

/**
 * 节点面板的显隐：宽屏按全局记住的“详情”开关；窄屏是抽屉，默认收起，打开不改变全局开关，
 * 切换到其他节点时收起。
 */
export function useDetails(nodeId: string | undefined) {
  const wide = useStore(detailsOpen);
  const narrow = useMedia(NARROW_QUERY);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [nodeId]);
  return {
    narrow,
    shown: narrow ? drawer : wide,
    toggle: () => narrow ? setDrawer(!drawer) : setDetailsOpen(!wide),
    close: () => narrow ? setDrawer(false) : setDetailsOpen(false),
  };
}

/** 标题栏的“详情”开关。 */
export function DetailsButton({ details }: { details: ReturnType<typeof useDetails> }) {
  return <button class={"chip-btn" + (details.shown ? " on" : "")} data-testid="details-toggle" onClick={details.toggle} title="显示或隐藏节点面板">详情</button>;
}

/**
 * 节点面板：可在多个适用面板之间切换。onClose 有值时是会话视图右侧的侧板（或窄屏抽屉），
 * 否则代替会话视图（group、resource 节点）。
 */
export function NodePanels({ node, panels, onClose, drawer, onOpenNode }: { node: TreeNode; panels: PanelSpec[]; onClose?: () => void; drawer?: boolean; onOpenNode: (id: string) => void }) {
  const [tab, setTab] = useState<string | undefined>(undefined);
  const panel = panels.find((p) => panelKey(p.source, p.id) === tab) ?? panels[0];
  if (!panel) return onClose ? null : <div class="placeholder">该节点没有可显示的内容。</div>;
  const current = panelKey(panel.source, panel.id);
  return (
    <aside class={"node-panel" + (onClose ? "" : " full") + (drawer ? " drawer" : "")} data-testid="node-panel" data-panel-id={panel.id}>
      <div class="panel-head">
        {panels.map((p) => { const key = panelKey(p.source, p.id); return <button key={key} class={"panel-tab" + (key === current ? " on" : "")} data-testid="panel-tab" onClick={() => setTab(key)}>{p.title}</button>; })}
        <span class="spacer" />
        <span class="src-tag">{pluginName(panel.source)}</span>
        {onClose && <button class="icon-btn" title="隐藏面板" data-testid="panel-close" onClick={onClose}>✕</button>}
      </div>
      <div class="panel-body"><PanelView key={current + "\u0000" + node.id} panel={panel} nodeId={node.id} onOpenNode={onOpenNode} /></div>
    </aside>
  );
}
