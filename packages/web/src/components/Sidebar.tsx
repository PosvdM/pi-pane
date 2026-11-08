// 侧栏：按项目分组的会话列表（architecture.md“会话列表”）。最近 7 天活动、托管中和当前打开的会话直接显示，其余折叠进“历史”。
import { useEffect, useMemo, useState } from "preact/hooks";
import { sidebarOpen } from "../lib/actions.ts";
import { current, openFile, refreshList, sessionList } from "../lib/session.ts";
import { useStore } from "../lib/store.ts";
import { overlay } from "../lib/ui-state.ts";
import type { PaneSessionListItem } from "../lib/types.ts";

const WEEK = 7 * 24 * 3600 * 1000;
const PAGE = 20;

function label(item: PaneSessionListItem): string { return item.name || item.title || "（空会话）"; }
function when(iso: string): string {
  const date = new Date(iso); const diff = Date.now() - date.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return date.toLocaleDateString("zh-CN");
}

function Project({ cwd, items, activeFile }: { cwd: string; items: PaneSessionListItem[]; activeFile?: string }) {
  const [shown, setShown] = useState(0);
  const recent = items.filter((i) => i.hosted || i.sessionFile === activeFile || Date.now() - new Date(i.modifiedAt).getTime() < WEEK);
  const history = items.filter((i) => !recent.includes(i));
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  return (
    <div class="project">
      <div class="project-head" title={cwd}>
        <span class="project-name">{name}</span>
        <button class="icon-btn" title="在此项目新建会话" data-testid="new-in-project" onClick={() => void openFile(cwd)}>＋</button>
      </div>
      {[...recent, ...history.slice(0, shown)].map((item) => (
        <button key={item.sessionFile} class={"session-item" + (item.sessionFile === activeFile ? " active" : "")} data-testid="session-item" title={item.sessionFile}
          onClick={() => void openFile(item.cwd, item.sessionFile)}>
          <span class={"status-dot s-" + (item.hosted ? item.status ?? "idle" : "none")} />
          <span class="session-label">{label(item)}</span>
          <span class="session-meta">{when(item.modifiedAt)} · {item.messageCount}</span>
        </button>
      ))}
      {history.length > shown && <button class="link history" onClick={() => setShown(shown + PAGE)}>历史（{history.length - shown}）</button>}
    </div>
  );
}

export function Sidebar() {
  const list = useStore(sessionList);
  const open = useStore(sidebarOpen);
  const state = useStore(current);
  const activeFile = state?.model?.view.sessionFile;
  useEffect(() => { void refreshList(); }, []);
  const groups = useMemo(() => {
    const map = new Map<string, PaneSessionListItem[]>();
    for (const item of list.items) { const group = map.get(item.cwd) ?? []; group.push(item); map.set(item.cwd, group); }
    return [...map.entries()].sort((a, b) => b[1][0].modifiedAt.localeCompare(a[1][0].modifiedAt));
  }, [list.items]);
  return (
    <aside class={"sidebar" + (open ? "" : " closed")} data-testid="sidebar">
      <div class="sidebar-head">
        <span class="brand">pi-pane</span>
        <span class="spacer" />
        <button class="icon-btn" title="刷新会话列表" onClick={() => void refreshList()}>⟳</button>
        <button class="icon-btn" title="设置" data-testid="open-settings" onClick={() => overlay.set("settings")}>⚙</button>
      </div>
      <button class="btn primary wide" data-testid="new-session" onClick={() => overlay.set("new-session")}>新建会话</button>
      <div class="session-list">
        {list.error && <div class="error-text">{list.error}</div>}
        {!list.items.length && !list.loading && <div class="muted pad">还没有会话。</div>}
        {groups.map(([cwd, items]) => <Project key={cwd} cwd={cwd} items={items} activeFile={activeFile} />)}
      </div>
    </aside>
  );
}
