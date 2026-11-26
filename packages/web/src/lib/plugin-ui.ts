// 插件交给浏览器的界面状态：持久表单、横幅、通知、用户在场确认、面板变更，以及动作与表单的提交流程（plugin-api.md 对应各节）。
import { api, ApiError, newId } from "./api.ts";
import { deviceLabel, getOrCreateDevice, PresenceError, resetDevice, signPresence, type DeviceInfo, type PresenceProof } from "./device-key.ts";
import { addNotificationTo, manualClose, NOTIFY_MS } from "./plugin-state.ts";
import { Operation, type OpEntry, type OpHost, type OpOptions, type OpState, type OpStep, type OpText } from "./operation.ts";
import { actionSpec, pluginName } from "./plugins.ts";
import { Store } from "./store.ts";
import { confirmInApp, toast } from "./ui-state.ts";
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
/** 已提交、结果未定的持久表单：submitting 请求在途，pending 插件已受理仍在处理，unknown 结果未知。弹窗关闭后重开仍按同一幂等键查询，不能再填一次。 */
export interface FormBusy { idempotencyKey: string; outcome: FormOutcome; revision: number; state: "submitting" | "pending" | "unknown"; message?: string }
export const formBusy = new Store<Record<string, FormBusy>>({});
export const banners = new Store<BannerState[]>([]);
export const notifications = new Store<PaneNotification[]>([]);
/** 发到本标签页、尚未关闭的在场确认，按到达顺序排队，一次显示一个。 */
export const presence = new Store<PanePresenceRequest[]>([]);
/** 面板的最新修订号与角标；显示中的面板据此重新拉取。键为 panelKey(source, panelId)。 */
export interface PanelState {
  revision: number;                 // 最近一次更新的修订号
  all: number;                      // 最近一次不带 nodeId（影响全部节点）的修订号
  nodes: Record<string, number>;    // 各节点最近一次更新的修订号；相邻两次更新指向不同节点时都要刷新
  badgeCount?: number | null;
}
export const panelState = new Store<Record<string, PanelState>>({});
/** 某个节点（或侧栏面板，nodeId 省略）应显示的面板修订号。 */
export function panelRevision(state: PanelState | undefined, nodeId?: string): number {
  if (!state) return 0;
  return nodeId ? Math.max(state.all, state.nodes[nodeId] ?? 0) : state.revision;
}
/**
 * 面板内容的代数：每次连接建立时加一，显示中的面板据此重新拉取。断线期间错过的 panelChanged 不会重放，
 * 丢掉修订号后有效修订号可能不变（如此前没收到过推送，前后都是 0），只看修订号就会一直显示断线前的内容。
 * 插件启用或变为不可用（plugins 帧）时不加：插件目录重读完成前重新拉取会读到已停用的插件；插件目录里的
 * PanelSpec.revision 变化时面板照常重新拉取（见 Panels.tsx）。
 */
export const panelGeneration = new Store<number>(0);
/** 插件重启后修订号可能从小值重新开始：丢掉该来源（省略时全部）的面板状态，以重读的插件目录为准。 */
function forgetPanels(source?: string): void {
  panelState.set((s) => source === undefined ? {} : Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith(panelKey(source, "")))));
}

/** 待处理区中打开的表单；附带表单（动作的 resolveForm 和 followUpForm）不进待处理区，单独记录。 */
export interface OpenForm { key: string; persistent: boolean; form: FormSpec; updated?: boolean; error?: string; submitting?: boolean; onSubmit?: (outcome: FormOutcome) => Promise<void> }
export const openForm = new Store<OpenForm | null>(null);

/** 待处理区排序：组内按 (createdAt, id) 升序。 */
export function sortedForms(list: Iterable<FormSpec>): FormSpec[] {
  // createdAt 可能带不同的时区或小数位，按时间值比较。
  const at = (form: FormSpec) => Date.parse(form.createdAt) || 0;
  return [...list].sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

/** 设备密钥的版本：本标签页或其他标签页重置密钥后加一，打开着的在场确认框据此重新读取签名设备。 */
export const deviceVersion = new Store<number>(0);
/** 同一浏览器的标签页共用 IndexedDB 中的密钥：一个标签页重置后通知其他标签页按新密钥重新登记。 */
const deviceChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("pi-pane-device") : null;
deviceChannel?.addEventListener("message", () => { deviceVersion.set((n) => n + 1); void registerDevice(); });

/** 设置页的“重置设备密钥”：生成新密钥，在本标签页和其他已打开的标签页重新登记。 */
export async function resetDeviceKey(): Promise<DeviceInfo> {
  const device = await resetDevice();
  sendDevice(device);
  deviceVersion.set((n) => n + 1);
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
        aligning = new Set(); presence.set([]); registered = null; forgetPanels(); panelGeneration.set((n) => n + 1);
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
      // 插件启用或变为不可用：重读插件列表、目录和各来源的树（没有横幅变化时也要刷新）。
      case "plugins": forgetPanels(message.source); onConnected(); break;
    }
  });
}

function applyPanel(source: string, update: PanelUpdate): void {
  const key = panelKey(source, update.panelId);
  panelState.set((s) => {
    const old = s[key];
    if (old && old.revision >= update.revision) return s;
    const badgeCount = update.badgeCount === undefined ? old?.badgeCount : update.badgeCount;
    const nodes = update.nodeId ? { ...old?.nodes, [update.nodeId]: update.revision } : old?.nodes ?? {};
    const all = update.nodeId ? old?.all ?? 0 : update.revision;
    return { ...s, [key]: { revision: update.revision, all, nodes, ...(badgeCount === undefined ? {} : { badgeCount }) } };
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

/**
 * 回应在场确认：确认时用设备密钥签名，拒绝时回 rejected，浏览器不支持时回 unsupported。
 * shownDeviceId 是确认框上显示的签名设备：签名用的密钥与它不同（确认框打开后其他标签页重置了密钥）时不发送，
 * 返回 "deviceChanged"，确认框刷新为新设备后由用户重新确认。
 */
export async function answerPresence(request: PanePresenceRequest, confirm: boolean, shownDeviceId?: string): Promise<void | "deviceChanged"> {
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
  if (shownDeviceId !== undefined && proof.deviceId !== shownDeviceId) {
    deviceVersion.set((n) => n + 1);
    return "deviceChanged";
  }
  // 服务端按本连接登记的设备核对签名设备；密钥已被其他标签页重置时先按签名用的密钥重新登记（同一连接上按序送达）。
  if (registered?.deviceId !== proof.deviceId || registered.connectionId !== ws.link.get().connectionId) {
    sendDevice({ deviceId: proof.deviceId, publicKey: proof.publicKey, alg: proof.alg, label: deviceLabel() });
  }
  return respondPresence(request, { proof });
}

/**
 * 浏览器等待一次插件操作请求（发消息、动作、提交表单及其查询）的最长时间。服务端等待插件最多 60 秒（plugin-api.md“运行方式与超时”），
 * 到时返回结果未知；这里再留出余量，只在响应挂起（服务端已返回而响应没有到达、连接卡住）时生效，按结果未知结算。
 */
export const PLUGIN_REQUEST_TIMEOUT_MS = 75_000;
export const pluginRequestSignal = () => AbortSignal.timeout(PLUGIN_REQUEST_TIMEOUT_MS);

const unknownResult = (error: unknown) => error instanceof ApiError && (error.code === "network" || error.code === "pluginTimeout" || error.status === 504);
/**
 * 操作的请求抛错时的结算：断网和超时结果未知；查询时的其他错误（如 WebSocket 重连期间的 403 invalidOrigin）
 * 是这次查询被拒，原操作的结果仍未知；首次请求被服务端拒绝时确定没有执行。
 */
export function requestFailed(error: unknown, query: boolean): OpStep {
  if (unknownResult(error)) return { state: "unknown" };
  return { state: query ? "unknown" : "notRun", message: (error as Error).message };
}
const pluginPath = (source: string, rest: string) => `/api/plugins/${encodeURIComponent(source)}/${rest}`;

/** 查询持久表单时这次查询本身没有成功（断网、超时、请求被拒）：已提交的结果仍未确定，进行中状态和弹窗都保持不变。 */
export class FormQueryFailed extends Error {}

/**
 * 提交持久表单，retry 给出时为用同一个幂等键查询。返回 true 表示弹窗可以关闭。
 * 查询时请求本身失败抛出 FormQueryFailed，不改动进行中状态（architecture.md“浏览器中的插件界面”）。
 */
export async function submitForm(form: FormSpec, outcome: FormOutcome, retry?: FormBusy): Promise<boolean> {
  const key = formKey(form.source, form.id);
  const idempotencyKey = retry?.idempotencyKey ?? newId(); const revision = retry?.revision ?? form.revision;
  const body = { revision, outcome: retry?.outcome ?? outcome, idempotencyKey, connectionId: ws.link.get().connectionId };
  const busy = (state: FormBusy["state"], message?: string) => formBusy.set((s) => ({ ...s, [key]: { idempotencyKey, outcome: body.outcome, revision, state, ...(message ? { message } : {}) } }));
  const clear = () => formBusy.set((s) => { const next = { ...s }; delete next[key]; return next; });
  let result: FormSubmitResult;
  if (!retry) busy("submitting");
  try { result = await api<FormSubmitResult>(pluginPath(form.source, `forms/${encodeURIComponent(form.id)}`), body, pluginRequestSignal()); }
  catch (error) {
    // 查询时请求失败（断网、浏览器超时、WebSocket 重连期间的 403 invalidOrigin 等）：失败的是这次查询，已提交的结果仍未确定，
    // 保留原来的进行中状态（pending 不改成结果未知）。
    if (retry) throw new FormQueryFailed(`这次查询没有成功（${(error as Error).message}），结果仍未确定，可以稍后再查`);
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

/**
 * 用同一个幂等键查询一次已提交表单的当前状态；同一表单的查询进行中时共用它。返回 true 表示弹窗可以关闭；
 * 这次查询没有成功时只提示，返回 false，弹窗留着以便再查。
 */
const formQueries = new Map<string, Promise<boolean>>();
export function queryForm(form: FormSpec): Promise<boolean> | undefined {
  const key = formKey(form.source, form.id);
  const running = formQueries.get(key);
  if (running) return running;
  const busy = formBusy.get()[key];
  if (!busy) return undefined;
  const query = submitForm(form, busy.outcome, busy).catch((error) => { toast((error as Error).message, "error"); return !(error instanceof FormQueryFailed); })
    .finally(() => { formQueries.delete(key); });
  formQueries.set(key, query);
  return query;
}

/**
 * 结果未确定的操作（动作调用、向插件会话发消息）的“查询结果”入口：pending 为插件已受理仍在处理，unknown 为超时或断网。
 * 每次操作是一个 Operation 对象（operation.ts），首次请求和每次查询的结果都由它结算，入口的 query 始终指向它。
 */
export type PendingOp = OpEntry;
export const pendingOps = new Store<PendingOp[]>([]);
/** 关闭查询入口（用户点 ✕）：不再查询，操作对象随之不可达。提交的原文在首次响应不是已送达时就已放回输入框，关闭不会丢失文字。 */
export function settleOp(key: string): void { pendingOps.set((list) => list.filter((a) => a.key !== key)); }
export function queryOp(op: PendingOp): Promise<unknown> { return op.query(); }

const opHost: OpHost = {
  show: (entry) => pendingOps.set((list) => [...list.filter((a) => a.key !== entry.key), entry]),
  hide: settleOp,
  toast: (message, level) => toast(message, level),
};
/** 新建一次操作；调用方随后调用 run() 发出首次请求。 */
export function newOperation(options: OpOptions): Operation { return new Operation(options, opHost); }

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
 * 一次动作调用对应的操作。needsInput 时弹出后续表单，提交沿用原幂等键作前缀（<原 key>/<n>），之后的查询用最近一次请求的键；
 * 用户放弃后续表单按没有执行结算。text 为输入框（composer 动作）移出的原文。
 */
function actionOperation(first: Call, onOpenNode?: (nodeId: string) => void, text?: OpText): Operation {
  const { spec } = first;
  const base = first.key;
  let call = first; let followUp = 0;
  const attempt = async (query: boolean): Promise<OpStep> => {
    for (;;) {
      let result: ActionResult;
      try {
        result = await api<ActionResult>(pluginPath(spec.source, `actions/${encodeURIComponent(spec.id)}/invoke`), {
          idempotencyKey: call.key, connectionId: ws.link.get().connectionId,
          ...(call.target ? { target: call.target } : {}), ...(call.input ? { input: call.input } : {}),
          ...(call.formId ? { formId: call.formId, formRevision: call.formRevision } : {}),
        }, pluginRequestSignal());
      } catch (error) { return requestFailed(error, query); }
      switch (result.status) {
        case "ok": if (result.openNodeId) onOpenNode?.(result.openNodeId); return { state: "done", message: result.message ?? `已${spec.title}` };
        case "pending": return { state: "pending", ...(result.message ? { message: result.message } : {}) };
        case "needsInput": {
          const form = result.followUpForm;
          const outcome = await askForm("action:" + base, form);
          if (outcome?.status !== "submitted") return { state: "notRun" };
          followUp++;
          call = { key: `${base}/${followUp}`, spec, ...(call.target ? { target: call.target } : {}), input: outcome.values, formId: form.id, formRevision: form.revision };
          continue;
        }
        default: return { state: "notRun", message: result.message };
      }
    }
  };
  return newOperation({ key: base, source: spec.source, attempt, pendingText: `“${spec.title}”处理中`, unknownText: `“${spec.title}”结果未知`, ...(text ? { text } : {}) });
}

/** 不经确认和 resolveForm 直接调用动作（输入框的 composer 动作）；每次调用生成新的幂等键。text 见 actionOperation。 */
export function invokeAction(spec: ActionSpec, target: ActionTarget | undefined, input: FormAnswers | undefined, onOpenNode?: (nodeId: string) => void, text?: OpText): Promise<OpState> {
  return actionOperation({ key: newId(), spec, ...(target ? { target } : {}), ...(input ? { input } : {}) }, onOpenNode, text).run();
}

/** 动作的点击流程：确认 → resolveForm → invoke（plugin-api.md“动作”）。用户在确认或附带表单处放弃时返回 abandoned。 */
export async function runAction(source: string, actionId: string, target: ActionTarget | undefined, onOpenNode?: (nodeId: string) => void): Promise<OpState | "abandoned"> {
  const spec = actionSpec(source, actionId);
  if (!spec) { toast("插件没有声明这个动作", "error"); return "notRun"; }
  if (spec.confirm && !(await confirmInApp(spec.confirm, spec.danger))) return "abandoned";
  const key = newId();
  if (spec.hasForm) {
    let form: FormSpec | null;
    try { form = (await api<{ form: FormSpec | null }>(pluginPath(source, `actions/${encodeURIComponent(actionId)}/form`), { target })).form; }
    catch (error) { toast((error as Error).message, "error"); return "notRun"; }
    if (form) {
      const outcome = await askForm("action:" + key, form);
      if (outcome?.status !== "submitted") return "abandoned";
      return actionOperation({ key, spec, ...(target ? { target } : {}), input: outcome.values, formId: form.id, formRevision: form.revision }, onOpenNode).run();
    }
  }
  return actionOperation({ key, spec, ...(target ? { target } : {}) }, onOpenNode).run();
}

/** 设置页：来源插件已从配置中移除的 persistent 横幅。 */
export async function removableBanners(): Promise<BannerState[]> {
  return (await api<{ banners: BannerState[] }>("/api/banners/removable")).banners;
}
export async function removeBanner(source: string, id: string): Promise<void> {
  await api("/api/banners/remove", { source, id, confirmed: true, connectionId: ws.link.get().connectionId });
}
