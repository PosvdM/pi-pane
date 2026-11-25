// 插件交给浏览器的界面状态：持久表单、横幅、通知、用户在场确认、面板变更，以及动作与表单的提交流程（plugin-api.md 对应各节）。
import { api, ApiError, newId } from "./api.ts";
import { deviceLabel, getOrCreateDevice, PresenceError, resetDevice, signPresence, type DeviceInfo, type PresenceProof } from "./device-key.ts";
import { addNotificationTo, manualClose, NOTIFY_MS } from "./plugin-state.ts";
import { actionSpec, pluginName } from "./plugins.ts";
import { Store } from "./store.ts";
import { toast } from "./ui-state.ts";
import * as ws from "./ws.ts";
import type {
  ActionResult, ActionSpec, ActionTarget, BannerState, FormAnswers, FormOutcome, FormSpec, FormSubmitResult, PaneNotification,
  PanePresenceRequest, PanelUpdate,
} from "./types.ts";

export const formKey = (source: string, id: string) => source + "\u0000" + id;
/** 面板以 (source, panelId) 识别：不同插件可以使用同一个 panelId。 */
export const panelKey = (source: string, panelId: string) => source + "\u0000" + panelId;

/** 待处理区的持久表单，键为 formKey(source, id)。 */
export const forms = new Store<Map<string, FormSpec>>(new Map());
/** 已提交、结果尚未确定的持久表单：pending 为插件已受理仍在处理，unknown 为请求超时或断网、结果未知。 */
export interface FormBusy { idempotencyKey: string; outcome: FormOutcome; revision: number; state: "pending" | "unknown"; message?: string }
export const formBusy = new Store<Record<string, FormBusy>>({});
export const banners = new Store<BannerState[]>([]);
export const notifications = new Store<PaneNotification[]>([]);
/** 发到本标签页、尚未关闭的在场确认，按到达顺序排队，一次显示一个。 */
export const presence = new Store<PanePresenceRequest[]>([]);
/** 面板的最新修订号与角标；显示中的面板据此重新拉取。键为 panelKey(source, panelId)。 */
export const panelState = new Store<Record<string, { revision: number; nodeId?: string; badgeCount?: number | null }>>({});

/** 待处理区中打开的表单；附带表单（动作的 resolveForm 和 followUpForm）不进待处理区，单独记录。 */
export interface OpenForm { key: string; persistent: boolean; form: FormSpec; updated?: boolean; error?: string; submitting?: boolean; onSubmit?: (outcome: FormOutcome) => Promise<void> }
export const openForm = new Store<OpenForm | null>(null);

/** 待处理区排序：组内按 (createdAt, id) 升序。 */
export function sortedForms(list: Iterable<FormSpec>): FormSpec[] {
  return [...list].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 连接建立后服务端重发的表单，收到 formsAligned 时以它为准替换待处理区；为 null 表示不在对齐中。 */
let aligning: Set<string> | null = null;

function upsertForm(form: FormSpec): void {
  const key = formKey(form.source, form.id);
  aligning?.add(key);
  const old = forms.get().get(key);
  if (old && old.revision >= form.revision) return;
  forms.get().set(key, form); forms.touch();
  const shown = openForm.get();
  if (shown?.persistent && shown.key === key) openForm.set({ ...shown, form, updated: true });
}
function removeForm(key: string, note?: string): void {
  aligning?.delete(key);
  if (forms.get().delete(key)) forms.touch();
  formBusy.set((s) => { if (!(key in s)) return s; const next = { ...s }; delete next[key]; return next; });
  const shown = openForm.get();
  if (shown?.persistent && shown.key === key) { openForm.set(null); if (note) toast(note); }
}
/** 对齐结束：本地还有、但服务端这次没有发来的表单已在断线期间被处理、撤回或过期，移除并关闭对应的弹窗。 */
function finishAlignment(): void {
  const kept = aligning; aligning = null;
  if (!kept) return;
  for (const key of [...forms.get().keys()]) if (!kept.has(key)) removeForm(key, "该事项已在别处处理");
}

export function dismissNotification(source: string, id: string): void {
  notifications.set((list) => list.filter((n) => !(n.source === source && n.id === id)));
}
function addNotification(notification: PaneNotification): void {
  const before = notifications.get();
  const after = addNotificationTo(before, notification);
  if (after === before) return;
  notifications.set(after);
  if (!manualClose(notification)) setTimeout(() => dismissNotification(notification.source, notification.id), NOTIFY_MS[notification.level as "info" | "warning"]);
}

/** 本连接最近一次登记的设备；签名用的密钥与它不同（其他标签页重置过密钥）时先重新登记。 */
let registered: { connectionId?: string; deviceId: string } | null = null;
function sendDevice(device: Pick<DeviceInfo, "deviceId" | "publicKey" | "alg" | "label">): boolean {
  const connectionId = ws.link.get().connectionId;
  if (!ws.send({ type: "device", device: { deviceId: device.deviceId, publicKey: device.publicKey, alg: device.alg, label: device.label, connected: true } })) return false;
  registered = { ...(connectionId ? { connectionId } : {}), deviceId: device.deviceId };
  return true;
}

/** 注册本浏览器的设备密钥，使在场确认能路由到本连接并核对签名设备；不支持时确认框直接以 unsupported 回应。 */
export async function registerDevice(): Promise<void> {
  try { sendDevice(await getOrCreateDevice()); } catch { /* 不支持 WebCrypto 或 IndexedDB：确认时回应 unsupported。 */ }
}

/** 同一浏览器的标签页共用 IndexedDB 中的密钥：一个标签页重置后通知其他标签页按新密钥重新登记。 */
const deviceChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("pi-pane-device") : null;
deviceChannel?.addEventListener("message", () => { void registerDevice(); });

/** 设置页的“重置设备密钥”：生成新密钥，在本标签页和其他已打开的标签页重新登记。 */
export async function resetDeviceKey(): Promise<DeviceInfo> {
  const device = await resetDevice();
  sendDevice(device);
  deviceChannel?.postMessage("reset");
  return device;
}

let installed = false;
/** onConnected 在每次连接建立时调用；横幅的来源可用性变化时也调用，用于重读插件列表和各来源的树。 */
export function installPluginHandlers(onConnected: () => void): void {
  if (installed) return; installed = true;
  ws.onMessage((message) => {
    switch (message.type) {
      case "banners":
        // 连接建立：横幅以服务端列表为准；表单由服务端对齐后逐条重发并以 formsAligned 结束，期间保留旧列表；
        // 在场确认属于旧连接，全部作废。
        banners.set(message.banners ?? []);
        aligning = new Set(); presence.set([]); registered = null;
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
      case "formRemoved": removeForm(formKey(message.source, message.formId)); break;
      case "formsAligned": finishAlignment(); break;
      case "notification": addNotification(message.notification); break;
      case "presence":
        presence.set((list) => [...list.filter((p) => p.id !== message.request.id), message.request]);
        void checkSigning(message.request);
        break;
      case "presenceClosed": presence.set((list) => list.filter((p) => p.id !== message.id)); break;
      case "panel": applyPanel(message.source, message.update); break;
    }
  });
}

function applyPanel(source: string, update: PanelUpdate): void {
  const key = panelKey(source, update.panelId);
  panelState.set((s) => {
    const old = s[key];
    if (old && old.revision >= update.revision) return s;
    const badgeCount = update.badgeCount === undefined ? old?.badgeCount : update.badgeCount;
    return { ...s, [key]: { revision: update.revision, ...(update.nodeId ? { nodeId: update.nodeId } : {}), ...(badgeCount === undefined ? {} : { badgeCount }) } };
  });
}

/** 浏览器无法签名（不支持 WebCrypto ECDSA 或 IndexedDB）时，确认不等用户操作，直接以 unsupported 结束。 */
async function checkSigning(request: PanePresenceRequest): Promise<void> {
  try { await getOrCreateDevice(); return; } catch { /* 下面以 unsupported 回应。 */ }
  if (!presence.get().some((p) => p.id === request.id)) return;
  await respondPresence(request, { error: "unsupported" });
  toast(`本浏览器无法签名（不支持 WebCrypto 或 IndexedDB），已告知 ${pluginName(request.source)} 无法确认`, "error");
}

async function respondPresence(request: PanePresenceRequest, response: { proof: PresenceProof } | { error: "rejected" | "unsupported" }): Promise<void> {
  presence.set((list) => list.filter((p) => p.id !== request.id));
  if (!ws.send({ type: "presenceResponse", id: request.id, response })) {
    const connectionId = ws.link.get().connectionId;
    try { await api(`/api/presence/${encodeURIComponent(request.id)}`, { connectionId, response }); } catch { toast("确认未能送达服务端", "error"); }
  }
}

/** 回应在场确认：确认时用设备密钥签名，拒绝时回 rejected，浏览器不支持时回 unsupported。 */
export async function answerPresence(request: PanePresenceRequest, confirm: boolean): Promise<void> {
  if (!confirm) return respondPresence(request, { error: "rejected" });
  let proof: PresenceProof;
  try {
    try { proof = await signPresence(request.payload); }
    catch (error) {
      // 其他标签页正在重置密钥时可能短暂没有密钥：取得（或生成）当前密钥后再签一次。
      if (!(error instanceof PresenceError && error.code === "noDevice")) throw error;
      await getOrCreateDevice(); proof = await signPresence(request.payload);
    }
  } catch {
    toast("本浏览器无法签名（不支持 WebCrypto 或 IndexedDB）", "error");
    return respondPresence(request, { error: "unsupported" });
  }
  // 服务端按本连接登记的设备核对签名设备；密钥已被其他标签页重置时先按签名用的密钥重新登记（同一连接上按序送达）。
  if (registered?.deviceId !== proof.deviceId || registered.connectionId !== ws.link.get().connectionId) {
    sendDevice({ deviceId: proof.deviceId, publicKey: proof.publicKey, alg: proof.alg, label: deviceLabel() });
  }
  return respondPresence(request, { proof });
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

/**
 * 结果未确定的操作（动作调用、向插件会话发消息）：pending 为插件已受理仍在处理，unknown 为超时或断网。
 * query 用原幂等键和同样的内容再调用一次，取得这次操作的当前状态（plugin-api.md“幂等规则”）。
 */
export interface PendingOp { key: string; source: string; state: "pending" | "unknown"; message: string; query: () => Promise<unknown> }
export const pendingOps = new Store<PendingOp[]>([]);
export function trackOp(op: PendingOp): void { pendingOps.set((list) => [...list.filter((a) => a.key !== op.key), op]); }
export function settleOp(key: string): void { pendingOps.set((list) => list.filter((a) => a.key !== key)); }

/**
 * 一次动作调用的最终去向：ok 已执行；pending 已受理仍在处理；unknown 结果未知；
 * failed 确定没有执行（插件拒绝、幂等冲突或请求被拒）；abandoned 用户放弃了确认或附带的表单，没有调用或没有完成。
 * pending 和 unknown 留下“查询结果”入口。
 */
export type ActionOutcome = "ok" | "pending" | "unknown" | "failed" | "abandoned";

/** 弹出动作附带的表单，返回用户的结果；用户放弃（关闭弹窗或打开了其他表单）时返回 null。 */
function askForm(key: string, form: FormSpec): Promise<FormOutcome | null> {
  return new Promise((resolve) => {
    let done = false;
    let off = () => {};
    const finish = (value: FormOutcome | null) => { if (done) return; done = true; off(); resolve(value); };
    openForm.set({ key, persistent: false, form, onSubmit: async (outcome) => { finish(outcome); openForm.set(null); } });
    off = openForm.subscribe(() => { if (openForm.get()?.key !== key) finish(null); });
  });
}

interface Call { key: string; spec: ActionSpec; target?: ActionTarget; input?: FormAnswers; formId?: string; formRevision?: number }

/**
 * notRun：之后的“查询结果”查到这次操作确定没有执行（failed）或用户放弃了后续表单时调用，
 * 供调用方取回提交时移走的内容（如输入框的文字）。
 */
async function invoke(call: Call, onOpenNode?: (nodeId: string) => void, followUp = 0, notRun?: () => void): Promise<ActionOutcome> {
  const { spec } = call;
  const query = async () => {
    const outcome = await invoke(call, onOpenNode, followUp, notRun);
    if (outcome === "failed" || outcome === "abandoned") notRun?.();
  };
  let result: ActionResult;
  try {
    result = await api<ActionResult>(pluginPath(spec.source, `actions/${encodeURIComponent(spec.id)}/invoke`), {
      idempotencyKey: call.key, connectionId: ws.link.get().connectionId,
      ...(call.target ? { target: call.target } : {}), ...(call.input ? { input: call.input } : {}),
      ...(call.formId ? { formId: call.formId, formRevision: call.formRevision } : {}),
    });
  } catch (error) {
    if (unknownResult(error)) {
      trackOp({ key: call.key, source: spec.source, state: "unknown", message: `“${spec.title}”结果未知`, query });
      return "unknown";
    }
    settleOp(call.key); toast((error as Error).message, "error"); return "failed";
  }
  switch (result.status) {
    case "ok": settleOp(call.key); toast(result.message ?? `已${spec.title}`); if (result.openNodeId) onOpenNode?.(result.openNodeId); return "ok";
    case "pending": trackOp({ key: call.key, source: spec.source, state: "pending", message: result.message ?? `“${spec.title}”处理中`, query }); return "pending";
    case "needsInput": {
      settleOp(call.key);
      // 后续表单的提交沿用原 key 作前缀：<原 key>/<n>。
      const base = call.key.replace(/\/\d+$/, ""); const n = followUp + 1; const form = result.followUpForm;
      const outcome = await askForm("action:" + base, form);
      if (outcome?.status !== "submitted") return "abandoned";
      return invoke({ key: `${base}/${n}`, spec, target: call.target, input: outcome.values, formId: form.id, formRevision: form.revision }, onOpenNode, n, notRun);
    }
    default: settleOp(call.key); toast(result.message, "error"); return "failed";
  }
}

/** 不经确认和 resolveForm 直接调用动作（输入框的 composer 动作）；每次调用生成新的幂等键。notRun 见 invoke。 */
export function invokeAction(spec: ActionSpec, target: ActionTarget | undefined, input: FormAnswers | undefined, onOpenNode?: (nodeId: string) => void, notRun?: () => void): Promise<ActionOutcome> {
  return invoke({ key: newId(), spec, ...(target ? { target } : {}), ...(input ? { input } : {}) }, onOpenNode, 0, notRun);
}

/** 动作的点击流程：确认 → resolveForm → invoke（plugin-api.md“动作”）。 */
export async function runAction(source: string, actionId: string, target: ActionTarget | undefined, onOpenNode?: (nodeId: string) => void): Promise<ActionOutcome> {
  const spec = actionSpec(source, actionId);
  if (!spec) { toast("插件没有声明这个动作", "error"); return "failed"; }
  if (spec.confirm && !confirm(spec.confirm)) return "abandoned";
  const key = newId();
  if (spec.hasForm) {
    let form: FormSpec | null;
    try { form = (await api<{ form: FormSpec | null }>(pluginPath(source, `actions/${encodeURIComponent(actionId)}/form`), { target })).form; }
    catch (error) { toast((error as Error).message, "error"); return "failed"; }
    if (form) {
      const outcome = await askForm("action:" + key, form);
      if (outcome?.status !== "submitted") return "abandoned";
      return invoke({ key, spec, target, input: outcome.values, formId: form.id, formRevision: form.revision }, onOpenNode);
    }
  }
  return invoke({ key, spec, target }, onOpenNode);
}

/** 设置页：来源插件已从配置中移除的 persistent 横幅。 */
export async function removableBanners(): Promise<BannerState[]> {
  return (await api<{ banners: BannerState[] }>("/api/banners/removable")).banners;
}
export async function removeBanner(source: string, id: string): Promise<void> {
  await api("/api/banners/remove", { source, id, confirmed: true, connectionId: ws.link.get().connectionId });
}
