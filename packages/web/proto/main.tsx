// M3 插件界面原型：不连服务端，用 data.ts 的假数据渲染。地址参数 ?scene= 选择截图场景：
// main（主界面）、sub（运行中的子会话）、readonly（Agent 管理的只读子会话）、form（待处理表单）、presence（用户在场确认）、
// banners（横幅与通知）、failed（失败的子会话）。?theme=light 强制浅色主题（默认跟随系统）。
// 运行：在 packages/web 下执行 npx vite --config proto/vite.config.js。
import { render } from "preact";
import { useState } from "preact/hooks";
import type { FormSpec } from "@pi-pane/plugin-api";
import { BANNERS, FORMS, PLUGIN_NODES } from "./data.ts";
import { FormDialog, PresenceDialog } from "./dialogs.tsx";
import { ProtoSidebar } from "./tree.tsx";
import { BannerStack, MainChat, NodePanel, NotificationToast, PluginSession } from "./views.tsx";
import "../src/style.css";
import "./proto.css";

const scene = new URLSearchParams(location.search).get("scene") ?? "main";
const START: Record<string, string> = { sub: "agora:session:as_a1", readonly: "agora:session:as_b2", failed: "agora:session:as_a3" };
if (new URLSearchParams(location.search).get("theme") === "light") document.documentElement.classList.add("theme-light");

function App() {
  const [active, setActive] = useState(START[scene] ?? "pane:session:s1");
  const [form, setForm] = useState<FormSpec | null>(scene === "form" ? FORMS[0] : null);
  const [busy, setBusy] = useState<string | undefined>(scene === "presence" ? FORMS[0].id : undefined);
  const [presence, setPresence] = useState(scene === "presence");
  const [toast, setToast] = useState(scene === "banners");
  const [panel, setPanel] = useState(true);
  const node = PLUGIN_NODES.find((n) => n.id === active);
  const open = (id: string) => { if (id.startsWith("pane:session:") || PLUGIN_NODES.some((n) => n.id === id && n.kind === "session")) setActive(id); };
  return (
    <div class="proto-shell">
      <BannerStack banners={scene === "banners" ? BANNERS : []} expanded={["agora:security:devices-reset"]} />
      <div class="layout proto-layout">
        <ProtoSidebar active={active} onOpen={open} forms={FORMS} busyForm={busy} onForm={setForm} />
        <main class={"main" + (node && panel ? " with-panel" : "")}>
          {node?.kind === "session"
            ? <>
                <PluginSession node={node} panelOpen={panel} onPanel={() => setPanel(!panel)} onOpen={open} forms={FORMS} onForm={setForm} />
                {panel && <NodePanel node={node} onClose={() => setPanel(false)} />}
              </>
            : <MainChat onOpen={open} />}
          {toast && <NotificationToast onOpen={open} onClose={() => setToast(false)} />}
        </main>
      </div>
      {form && <FormDialog form={form} initial={scene === "form" ? { q1: { selected: ["自己实现定高虚拟列表"] }, q2: { selected: [], custom: "需要，但先只做上下键" } } : undefined}
        onLater={() => setForm(null)} onSubmit={() => { setBusy(form.id); setForm(null); setPresence(true); }} />}
      {presence && <PresenceDialog showPayload={scene === "presence"} onClose={() => { setPresence(false); setBusy(undefined); }} />}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
