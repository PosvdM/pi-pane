// 插件交给浏览器的界面状态：持久表单、横幅、通知、用户在场确认、面板变更，以及动作与表单的提交流程（plugin-api.md 对应各节）。
import { api, ApiError, newId } from "./api.ts";
import { getOrCreateDevice, signPresence } from "./device-key.ts";
import { actionSpec } from "./plugins.ts";
import { Store } from "./store.ts";
import { toast } from "./ui-state.ts";
import * as ws from "./ws.ts";
import type {
  ActionResult, ActionSpec, ActionTarget, BannerState, FormAnswers, FormOutcome, FormSpec, FormSubmitResult, PaneNotification,
  PanePresenceRequest, PanelUpdate,
} from "./types.ts";

export const formKey = (source: string, id: string) => source + "\u0000" + id;

/** 待处理区的持久表单，键为 formKey(source, id)。 */
export const forms = new Store<Map<string, FormSpec>>(new Map());
/** 已提交、结果尚未确定的持久表单：pending 为插件已受理仍在处理，unknown 为请求超时或断网、结果未知。 */
export interface FormBusy { idempotencyKey: string; outcome: FormOutcome; revision: number; state: "pending" | "unknown"; message?: string }
export const formBusy = new Store<Record<string, FormBusy>>({});
export const banners = new Store<BannerState[]>([]);
export const notifications = new Store<PaneNotification[]>([]);
/** 发到本标签页、尚未关闭的在场确认，按到达顺序排队，一次显示一个。 */
export const presence = new Store<PanePresenceRequest[]>([]);
/** 面板的最新修订号与角标；显示中的面板据此重新拉取。键为 panelId。 */
export const panelState = new Store<Record<string, { revision: number; nodeId?: string; badgeCount?: number | null }>>({});

/** 待处理区中打开的表单；附带表单（动作的 resolveForm 和 followUpForm）不进待处理区，单独记录。 */
export interface OpenForm { key: string; persistent: boolean; form: FormSpec; updated?: boolean; error?: string; submitting?: boolean; onSubmit?: (outcome: FormOutcome) => Promise<void> }
export const openForm = new Store<OpenForm | null>(null);

/** 待处理区排序：组内按 (createdAt, id) 升序。 */
export function sortedForms(list: Iterable<FormSpec>): FormSpec[] {
  return [...list].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function upsertForm(form: FormSpec): void {
  const key = formKey(form.source, form.id);
  const old = forms.get().get(key);
  if (old && old.revision >= form.revision) return;
  forms.get().set(key, form); forms.touch();
  const shown = openForm.get();
  if (shown?.persistent && shown.key === key) openForm.set({ ...shown, form, updated: true });
}
function removeForm(source: string, formId: string): void {
  const key = formKey(source, formId);
  if (forms.get().delete(key)) forms.touch();
  formBusy.set((s) => { if (!(key in s)) return s; const next = { ...s }; delete next[key]; return next; });
  const shown = openForm.get();
  if (shown?.persistent && shown.key === key) openForm.set(null);
}

export function dismissNotification(source: string, id: string): void {
  notifications.set((list) => list.filter((n) => !(n.source === source && n.id === id)));
}
function addNotification(notification: PaneNotification): void {
  if (notifications.get().some((n) => n.source === notification.source && n.id === notification.id)) return;
  notifications.set((list) => [...list.slice(-4), notification]);
  if (notification.level !== "error" && !notification.sticky) setTimeout(() => dismissNotification(notification.source, notification.id), 8000);
}

/** 注册本浏览器的设备密钥，使在场确认能路由到本连接并核对签名设备；不支持时确认框直接以 unsupported 回应。 */
export async function registerDevice(): Promise<void> {
  try {
    const device = await getOrCreateDevice();
    ws.send({ type: "device", device: { deviceId: device.deviceId, publicKey: device.publicKey, alg: device.alg, label: device.label, connected: true } });
  } catch { /* 不支持 WebCrypto 或 IndexedDB：确认时回应 unsupported。 */ }
}

let installed = false;
/** onConnected 在每次连接建立时调用；横幅的来源可用性变化时也调用，用于重读插件列表和各来源的树。 */
export function installPluginHandlers(onConnected: () => void): void {
  if (installed) return; installed = true;
  ws.onMessage((message) => {
    switch (message.type) {
      case "banners":
        // 连接建立：横幅以服务端列表为准；表单由服务端随后逐条重发，先清空；在场确认属于旧连接，全部作废。
        banners.set(message.banners ?? []);
        forms.set(new Map()); presence.set([]);
        void registerDevice(); onConnected();
        break;
      case "banner": {
        const old = banners.get().find((b) => b.source === message.banner.source && b.id === message.banner.id);
        // 同一条横幅更新时保持原位置；顺序即设置时间。
        banners.set((list) => old ? list.map((b) => b === old ? message.banner : b) : [...list, message.banner]);
        if (old && old.sourceUnavailable !== message.banner.sourceUnavailable) onConnected();
        break;
      }
      case "bannerCleared": banners.set((list) => list.filter((b) => !(b.source === message.source && b.id === message.id))); break;
      case "form": upsertForm(message.form); break;
      case "formRemoved": removeForm(message.source, message.formId); break;
      case "notification": addNotification(message.notification); break;
      case "presence": presence.set((list) => [...list.filter((p) => p.id !== message.request.id), message.request]); break;
      case "presenceClosed": presence.set((list) => list.filter((p) => p.id !== message.id)); break;
      case "panel": applyPanel(message.update); break;
    }
  });
}

function applyPanel(update: PanelUpdate): void {
  panelState.set((s) => {
    const old = s[update.panelId];
    if (old && old.revision >= update.revision) return s;
    const badgeCount = update.badgeCount === undefined ? old?.badgeCount : update.badgeCount;
    return { ...s, [update.panelId]: { revision: update.revision, ...(update.nodeId ? { nodeId: update.nodeId } : {}), ...(badgeCount === undefined ? {} : { badgeCount }) } };
  });
}

/** 回应在场确认：确认时用设备密钥签名，拒绝时回 rejected，浏览器不支持时回 unsupported。 */
export async function answerPresence(request: PanePresenceRequest, confirm: boolean): Promise<void> {
  let response: unknown;
  if (!confirm) response = { error: "rejected" };
  else {
    try { response = { proof: await signPresence(request.payload) }; }
    catch { response = { error: "unsupported" }; toast("本浏览器无法签名（不支持 WebCrypto 或 IndexedDB）", "error"); }
  }
  presence.set((list) => list.filter((p) => p.id !== request.id));
  if (!ws.send({ type: "presenceResponse", id: request.id, response })) {
    const connectionId = ws.link.get().connectionId;
    try { await api(`/api/presence/${encodeURIComponent(request.id)}`, { connectionId, response }); } catch { toast("确认未能送达服务端", "error"); }
  }
}

const unknownResult = (error: unknown) => error instanceof ApiError && (error.code === "network" || error.code === "pluginTimeout" || error.status === 504);
const pluginPath = (source: string, rest: string) => `/api/plugins/${encodeURIComponent(source)}/${rest}`;

/** 提交持久表单。返回 true 表示弹窗可以关闭。 */
export async function submitForm(form: FormSpec, outcome: FormOutcome, retry?: FormBusy): Promise<boolean> {
  const key = formKey(form.source, form.id);
  const idempotencyKey = retry?.idempotencyKey ?? newId(); const revision = retry?.revision ?? form.revision;
  const body = { revision, outcome: retry?.outcome ?? outcome, idempotencyKey, connectionId: ws.link.get().connectionId };
  const busy = (state: FormBusy["state"], message?: string) => formBusy.set((s) => ({ ...s, [key]: { idempotencyKey, outcome: body.outcome, revision, state, ...(message ? { message } : {}) } }));
  const clear = () => formBusy.set((s) => { const next = { ...s }; delete next[key]; return next; });
  let result: FormSubmitResult;
  try { result = await api<FormSubmitResult>(pluginPath(form.source, `forms/${encodeURIComponent(form.id)}`), body); }
  catch (error) {
    if (unknownResult(error)) { busy("unknown", "结果未知"); return true; }
    clear(); throw error;
  }
  switch (result.status) {
    case "accepted": clear(); if (result.message) toast(result.message); return true;
    case "pending": busy("pending", result.message); return true;
    case "alreadyHandled": clear(); toast(result.message ?? "已在别处处理"); return true;
    case "stale": clear(); upsertForm(result.form); return false;
    default: clear(); throw new Error(result.message);
  }
}

/** 用同一个幂等键查询一次已提交表单的当前状态。 */
export function queryForm(form: FormSpec): Promise<boolean> | undefined {
  const busy = formBusy.get()[formKey(form.source, form.id)];
  return busy ? submitForm(form, busy.outcome, busy).catch((error) => { toast((error as Error).message, "error"); return true; }) : undefined;
}

/** 动作调用的结果未知时保留的查询入口，键为调用的幂等键。 */
export interface PendingAction { key: string; spec: ActionSpec; target?: ActionTarget; input?: FormAnswers; formId?: string; formRevision?: number; state: "pending" | "unknown"; message?: string }
export const pendingActions = new Store<PendingAction[]>([]);

function settleAction(key: string): void { pendingActions.set((list) => list.filter((a) => a.key !== key)); }

async function invoke(call: Omit<PendingAction, "state" | "message">, onOpenNode?: (nodeId: string) => void, followUp = 0): Promise<void> {
  const { spec } = call;
  let result: ActionResult;
  try {
    result = await api<ActionResult>(pluginPath(spec.source, `actions/${encodeURIComponent(spec.id)}/invoke`), {
      idempotencyKey: call.key, connectionId: ws.link.get().connectionId,
      ...(call.target ? { target: call.target } : {}), ...(call.input ? { input: call.input } : {}),
      ...(call.formId ? { formId: call.formId, formRevision: call.formRevision } : {}),
    });
  } catch (error) {
    if (unknownResult(error)) {
      pendingActions.set((list) => [...list.filter((a) => a.key !== call.key), { ...call, state: "unknown", message: `“${spec.title}”结果未知` }]);
      return;
    }
    settleAction(call.key); toast((error as Error).message, "error"); return;
  }
  switch (result.status) {
    case "ok": settleAction(call.key); toast(result.message ?? `已${spec.title}`); if (result.openNodeId) onOpenNode?.(result.openNodeId); return;
    case "pending": pendingActions.set((list) => [...list.filter((a) => a.key !== call.key), { ...call, state: "pending", message: result.message ?? `“${spec.title}”处理中` }]); return;
    case "needsInput": {
      settleAction(call.key);
      const base = call.key.replace(/\/\d+$/, ""); const n = followUp + 1; const form = result.followUpForm;
      openForm.set({ key: "action:" + base, persistent: false, form, onSubmit: async (outcome) => {
        if (outcome.status !== "submitted") { openForm.set(null); return; }
        openForm.set(null);
        await invoke({ key: `${base}/${n}`, spec, target: call.target, input: outcome.values, formId: form.id, formRevision: form.revision }, onOpenNode, n);
      } });
      return;
    }
    default: settleAction(call.key); toast(result.message, "error");
  }
}

/** 动作的点击流程：确认 → resolveForm → invoke（plugin-api.md“动作”）。 */
export async function runAction(source: string, actionId: string, target: ActionTarget | undefined, onOpenNode?: (nodeId: string) => void): Promise<void> {
  const spec = actionSpec(source, actionId);
  if (!spec) { toast("插件没有声明这个动作", "error"); return; }
  if (spec.confirm && !confirm(spec.confirm)) return;
  const key = newId();
  if (spec.hasForm) {
    let form: FormSpec | null;
    try { form = (await api<{ form: FormSpec | null }>(pluginPath(source, `actions/${encodeURIComponent(actionId)}/form`), { target })).form; }
    catch (error) { toast((error as Error).message, "error"); return; }
    if (form) {
      const resolved = form;
      openForm.set({ key: "action:" + key, persistent: false, form: resolved, onSubmit: async (outcome) => {
        openForm.set(null);
        if (outcome.status === "submitted") await invoke({ key, spec, target, input: outcome.values, formId: resolved.id, formRevision: resolved.revision }, onOpenNode);
      } });
      return;
    }
  }
  await invoke({ key, spec, target }, onOpenNode);
}

/** “查询结果”：同一个幂等键、同样的内容再调用一次。 */
export function queryAction(action: PendingAction, onOpenNode?: (nodeId: string) => void): Promise<void> {
  const { state: _state, message: _message, ...call } = action;
  return invoke(call, onOpenNode, Number(/\/(\d+)$/.exec(action.key)?.[1] ?? 0));
}

/** 设置页：来源插件已从配置中移除的 persistent 横幅。 */
export async function removableBanners(): Promise<BannerState[]> {
  return (await api<{ banners: BannerState[] }>("/api/banners/removable")).banners;
}
export async function removeBanner(source: string, id: string): Promise<void> {
  await api("/api/banners/remove", { source, id, confirmed: true, connectionId: ws.link.get().connectionId });
}
