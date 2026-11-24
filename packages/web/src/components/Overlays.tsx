// 弹层：设置、模型与思考级别选择、会话信息、分叉、新建会话。
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { logout } from "../lib/auth.ts";
import { detectSupport, getOrCreateDevice, resetDevice, setDeviceLabel, type DeviceInfo } from "../lib/device-key.ts";
import { control, current, openFile, query, sessionList } from "../lib/session.ts";
import { settings, updateSettings } from "../lib/settings.ts";
import { useStore } from "../lib/store.ts";
import { ask, overlay, toast } from "../lib/ui-state.ts";
import type { PaneForkPoint, PaneModel, PaneSessionState, PaneSessionStats, PaneThinkingLevel } from "../lib/types.ts";
import { Modal } from "./Dialogs.tsx";

const close = () => overlay.set(null);

async function conflictAware(command: Parameters<typeof control>[0], label: string): Promise<boolean> {
  const outcome = await control(command);
  if (outcome.ok) { toast(label); return true; }
  if (outcome.error.code === "revisionChanged") {
    const latest = current.get()?.model?.view.state;
    toast(`另一个标签页刚刚修改了会话状态（当前模型 ${latest?.model ? `${latest.model.provider}/${latest.model.id}` : "未知"}，思考 ${latest?.thinkingLevel ?? "未知"}），请确认后重新选择`, "warning");
  } else toast(outcome.error.message, "error");
  return false;
}

function ModelPicker() {
  const [models, setModels] = useState<PaneModel[] | null>(null);
  const [filter, setFilter] = useState("");
  const state = useStore(current);
  const active = state?.model?.view.state?.model;
  useEffect(() => { query("models").then((r) => setModels(r?.models ?? []), (e) => { toast(e.message, "error"); setModels([]); }); }, []);
  const shown = (models ?? []).filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal title="选择模型" onClose={close} testid="model-picker">
      <input class="text-input" placeholder="筛选" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} autoFocus />
      <div class="options scroll">
        {models === null && <div class="muted">加载中…</div>}
        {shown.map((m) => (
          <button key={m.provider + m.id} class={"option" + (active?.provider === m.provider && active.id === m.id ? " active" : "")}
            onClick={async () => { if (await conflictAware({ type: "set_model", provider: m.provider, modelId: m.id }, `已切换到 ${m.name}`)) close(); }}>
            <span>{m.name}</span><span class="muted small">{m.provider}/{m.id}{m.images ? " · 图片" : ""}{m.reasoning ? " · 思考" : ""}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

const LEVELS: PaneThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function ThinkingPicker() {
  const state = useStore(current);
  const level = state?.model?.view.state?.thinkingLevel;
  return (
    <Modal title="思考级别" onClose={close} testid="thinking-picker">
      <div class="options">
        {LEVELS.map((l) => <button key={l} class={"option" + (l === level ? " active" : "")} onClick={async () => { if (await conflictAware({ type: "set_thinking_level", level: l }, `思考级别：${l}`)) close(); }}>{l}</button>)}
      </div>
      <p class="muted small">xhigh、max 只在模型支持时可用。</p>
    </Modal>
  );
}

function SessionInfo() {
  const [info, setInfo] = useState<{ state: PaneSessionState | null; stats: PaneSessionStats | null } | null>(null);
  const view = useStore(current)?.model?.view;
  useEffect(() => { Promise.all([query("state"), query("stats")]).then(([state, stats]) => setInfo({ state, stats }), (e) => toast(e.message, "error")); }, []);
  const s = info?.stats;
  return (
    <Modal title="会话信息" onClose={close} testid="session-info">
      <table class="kv">
        <tbody>
          <tr><th>会话文件</th><td>{view?.sessionFile}</td></tr>
          <tr><th>项目目录</th><td>{view?.cwd}</td></tr>
          <tr><th>名称</th><td>{info?.state?.sessionName ?? "—"}</td></tr>
          <tr><th>模型</th><td>{info?.state?.model ? `${info.state.model.provider}/${info.state.model.id}` : "—"}</td></tr>
          <tr><th>思考级别</th><td>{info?.state?.thinkingLevel ?? "—"}</td></tr>
          {s && <>
            <tr><th>消息</th><td>用户 {s.messages.user} · 助手 {s.messages.assistant} · 工具调用 {s.messages.toolCalls}</td></tr>
            <tr><th>Tokens</th><td>输入 {s.tokens.input} · 输出 {s.tokens.output} · 缓存读 {s.tokens.cacheRead} · 缓存写 {s.tokens.cacheWrite} · 合计 {s.tokens.total}</td></tr>
            <tr><th>费用</th><td>${s.cost.toFixed(4)}</td></tr>
            {s.context && <tr><th>上下文</th><td>{s.context.tokens ?? "—"} / {s.context.window}{s.context.percent != null ? `（${Math.round(s.context.percent)}%）` : ""}</td></tr>}
          </>}
        </tbody>
      </table>
      {!view?.hosted && <p class="muted small">会话未启动，发送消息后可查看用量。</p>}
    </Modal>
  );
}

function ForkPicker() {
  const [points, setPoints] = useState<PaneForkPoint[] | null>(null);
  useEffect(() => { query("forkPoints").then((r) => setPoints(r?.points ?? []), (e) => { toast(e.message, "error"); setPoints([]); }); }, []);
  return (
    <Modal title="从哪条消息分叉" onClose={close} testid="fork-picker">
      <div class="options scroll">
        {points === null && <div class="muted">加载中…</div>}
        {points?.length === 0 && <div class="muted">没有可分叉的用户消息。</div>}
        {points?.map((p) => (
          <button key={p.entryId} class="option" onClick={async () => {
            close();
            const outcome = await control({ type: "fork", entryId: p.entryId });
            if (!outcome.ok) toast(outcome.error.message, "error");
            else if (outcome.result.status === "accepted" && outcome.result.result?.cancelled) toast("分叉被扩展取消", "warning");
          }}>{p.text.length > 200 ? p.text.slice(0, 200) + "…" : p.text}</button>
        ))}
      </div>
    </Modal>
  );
}

function NewSession() {
  const list = useStore(sessionList);
  const projects = [...new Set(list.items.map((i) => i.cwd))];
  const [cwd, setCwd] = useState(current.get()?.model?.view.cwd ?? projects[0] ?? "");
  return (
    <Modal title="新建会话" onClose={close} testid="new-session-dialog">
      <form onSubmit={(e) => { e.preventDefault(); if (!cwd.trim()) return; close(); void openFile(cwd.trim()); }}>
        <label class="field">项目目录（绝对路径）
          <input class="text-input" data-testid="new-session-cwd" list="known-projects" value={cwd} onInput={(e) => setCwd(e.currentTarget.value)} autoFocus />
        </label>
        <datalist id="known-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <div class="modal-actions">
          <button type="button" class="btn" onClick={close}>取消</button>
          <button type="submit" class="btn primary" data-testid="new-session-create">创建</button>
        </div>
      </form>
    </Modal>
  );
}

function Settings() {
  const prefs = useStore(settings);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  useEffect(() => {
    const support = detectSupport();
    if (!support.ok) { setDeviceError(support.reason); return; }
    getOrCreateDevice().then((d) => { setDevice(d); setLabel(d.label); }, (e) => setDeviceError(e.message));
  }, []);
  return (
    <Modal title="设置" onClose={close} testid="settings" wide>
      <section>
        <h3>设备密钥</h3>
        {deviceError && <p class="error-text">不可用：{deviceError}</p>}
        {device && (
          <>
            <table class="kv"><tbody>
              <tr><th>设备 ID</th><td data-testid="device-id" title={device.deviceId}>{device.deviceId.slice(0, 12)}…</td></tr>
              <tr><th>算法</th><td>{device.alg}</td></tr>
              <tr><th>创建时间</th><td>{new Date(device.createdAt).toLocaleString("zh-CN")}</td></tr>
            </tbody></table>
            <div class="row">
              <input class="text-input" value={label} onInput={(e) => setLabel(e.currentTarget.value)} aria-label="设备名称" />
              <button class="btn" onClick={() => { setDeviceLabel(label); toast("已保存设备名称"); }}>保存名称</button>
              <button class="btn danger" onClick={async () => {
                const answer = await ask("重置设备密钥", "重置后会生成新的密钥，插件后台服务会把本浏览器当作新设备，需要重新批准。", [{ label: "取消", value: "no" }, { label: "重置", value: "yes", danger: true }]);
                if (answer === "yes") { const d = await resetDevice(); setDevice(d); toast("已重置设备密钥"); }
              }}>重置设备密钥</button>
            </div>
            <p class="muted small">私钥不可导出，只用于用户在场确认的签名。清除浏览器数据、换端口或换浏览器都等于一台新设备。</p>
          </>
        )}
      </section>
      <section>
        <h3>显示</h3>
        <label class="check"><input type="checkbox" checked={prefs.showHidden} onChange={(e) => updateSettings({ showHidden: e.currentTarget.checked })} /> 显示隐藏消息（扩展设置为不显示的自定义消息）</label>
      </section>
      <section>
        <h3>浏览器</h3>
        <div class="row">
          <button class="btn" data-testid="add-browser" onClick={async () => { try { setCode((await api<{ code: string }>("/api/auth/code", {})).code); } catch (e) { toast((e as Error).message, "error"); } }}>添加浏览器</button>
          <button class="btn danger" data-testid="logout" onClick={() => { close(); void logout(); }}>退出登录</button>
        </div>
        {code && <p>在另一个浏览器打开：<code class="select">{`${location.origin}/#code=${code}`}</code><br /><span class="muted small">配对码使用一次或十分钟后失效。</span></p>}
      </section>
    </Modal>
  );
}

export function Overlays() {
  const which = useStore(overlay);
  const hosted = useStore(current)?.model?.view.hosted;
  if (!which) return null;
  if (["models", "thinking", "fork"].includes(which) && !hosted) { setTimeout(() => { overlay.set(null); toast("会话还没有启动，先发送一条消息"); }); return null; }
  switch (which) {
    case "settings": return <Settings />;
    case "models": return <ModelPicker />;
    case "thinking": return <ThinkingPicker />;
    case "session-info": return <SessionInfo />;
    case "fork": return <ForkPicker />;
    case "new-session": return <NewSession />;
  }
}
