// 应用外壳：配对页或主界面（侧栏 + 会话视图 + 弹窗）。
import { useEffect, useState } from "preact/hooks";
import { auth, boot, pair } from "./lib/auth.ts";
import { installEventHandlers } from "./lib/events.ts";
import { getOrCreateDevice } from "./lib/device-key.ts";
import { current, detach, lastSessionId, open } from "./lib/session.ts";
import { useStore } from "./lib/store.ts";
import { link, start, stop } from "./lib/ws.ts";
import { installTab, tabReady } from "./lib/tab.ts";
import { restoreClaims } from "./lib/saved-drafts.ts";
import { sidebarOpen } from "./lib/actions.ts";
import { overlay } from "./lib/ui-state.ts";
import { ChatView } from "./components/Chat.tsx";
import { ChoiceView, ExtensionDialog, Toasts, TrustDialog } from "./components/Dialogs.tsx";
import { Overlays } from "./components/Overlays.tsx";
import { BannerStack, FormDialog, PluginToasts, PresenceDialog } from "./components/PluginDialogs.tsx";
import { PluginSessionView } from "./components/PluginSession.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { pluginView } from "./lib/plugin-session.ts";
import { installPluginHandlers } from "./lib/plugin-ui.ts";
import { refreshPlugins } from "./lib/plugins.ts";
import { syncSources } from "./lib/tree.ts";

installEventHandlers();
// 每次 WebSocket 建立：重读插件列表和目录，再为 pane 和各活动插件取树快照（已有快照的来源由 ws.ts 按游标续订）。
installPluginHandlers(() => { void refreshPlugins().then(syncSources); });

function PairPage() {
  const state = useStore(auth);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div class="pair-page">
      <form class="pair-card" data-testid="pair-page" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await pair(code, state.instanceId); setBusy(false); }}>
        <h1>pi-pane</h1>
        <p>在运行 pi-pane 的终端里找到配对地址并在本浏览器打开，或在下面输入配对码。在终端按 Enter 可以生成新的配对码。</p>
        {state.message && <p class="error-text" data-testid="pair-message">{state.message}</p>}
        <input class="text-input" data-testid="pair-code" placeholder="配对码" value={code} onInput={(e) => setCode(e.currentTarget.value)} autoFocus />
        <button class="btn primary wide" type="submit" disabled={!code.trim() || busy}>配对</button>
      </form>
    </div>
  );
}

function Main() {
  const state = useStore(current);
  const net = useStore(link);
  const sidebar = useStore(sidebarOpen);
  const plugin = useStore(pluginView);
  useEffect(() => {
    start();
    // 登录后即建立设备密钥（plugin-api.md“设备密钥”）；不支持时在设置页显示原因。
    getOrCreateDevice().catch(() => {});
    const last = lastSessionId();
    if (last && !current.get()) void open(last);
    return () => { detach(); stop(); };
  }, []);
  return (
    <div class="shell">
    <BannerStack />
    <div class={"layout" + (sidebar ? "" : " no-sidebar")}>
      <Sidebar />
      <main class="main">
        <button class="icon-btn sidebar-toggle" title="会话列表" onClick={() => sidebarOpen.set(!sidebar)}>☰</button>
        {net.state !== "open" && <div class="net-banner" data-testid="net-banner">{net.state === "connecting" ? "正在连接…" : "连接已断开，正在重连…"}</div>}
        {plugin ? <PluginSessionView /> : state?.model ? <ChatView /> : (
          <div class="placeholder">
            {state?.loading ? "加载中…" : state?.error ? <span class="error-text">{state.error}</span> : (
              <div>
                <p>从左侧选择一个会话，或新建会话。</p>
                <button class="btn primary" onClick={() => overlay.set("new-session")}>新建会话</button>
              </div>
            )}
          </div>
        )}
      </main>
      <ExtensionDialog />
      <TrustDialog />
      <Overlays />
      <ChoiceView />
      <FormDialog />
      <PresenceDialog />
    </div>
    </div>
  );
}

export function App() {
  const state = useStore(auth);
  // 输入框草稿按标签页保存：标签页标识确定之前不进入主界面。
  const tab = useStore(tabReady);
  // 本标签页结果未知的领取按 tabId 保存在 sessionStorage 中，主界面显示之前恢复。
  useEffect(() => { void boot(); void installTab((tabId) => { let storage: Storage | null = null; try { storage = sessionStorage; } catch { /* 不可用。 */ } restoreClaims(storage, tabId); }); }, []);
  return (
    <>
      {state.phase === "ready" && tab ? <Main /> : state.phase === "pairing" ? <PairPage /> : (
        <div class="pair-page"><div class="pair-card">{state.phase === "loading" || state.phase === "ready" ? "正在连接 pi-pane…" : <>
          <p class="error-text">{state.message}</p><button class="btn" onClick={() => void boot()}>重试</button></>}</div></div>
      )}
      {/* 普通提示与插件通知同在一列，从横幅下方开始。 */}
      <div class="toast-column">
        <Toasts />
        {state.phase === "ready" && <PluginToasts />}
      </div>
    </>
  );
}
