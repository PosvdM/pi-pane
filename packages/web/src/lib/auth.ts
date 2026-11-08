// 配对与会话凭证（architecture.md“鉴权”）。
// 凭证只放在内存和 sessionStorage；同一浏览器的新标签页经 BroadcastChannel 向持有同一 instanceId 凭证的标签页索取。
import { api, setCredential, setUnauthorizedHandler } from "./api.ts";
import { Store } from "./store.ts";
import type { PaneErrorBody } from "./types.ts";

const STORAGE_KEY = "pi-pane.auth";
const CHANNEL = "pi-pane-auth";
const ASK_TIMEOUT_MS = 400;

export type AuthPhase = "loading" | "pairing" | "ready" | "unavailable";
export interface AuthState { phase: AuthPhase; instanceId?: string; message?: string }
export const auth = new Store<AuthState>({ phase: "loading" });

interface Saved { credential: string; instanceId: string }
type ChannelMessage =
  | { type: "request"; instanceId: string; nonce: string }
  | { type: "credential"; instanceId: string; credential: string; nonce: string }
  | { type: "logout"; credential: string };

let saved: Saved | null = null;
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;

function load(): Saved | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    return value && typeof value.credential === "string" && typeof value.instanceId === "string" ? value : null;
  } catch { return null; }
}
function store(value: Saved | null): void {
  saved = value; setCredential(value?.credential ?? null);
  if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else sessionStorage.removeItem(STORAGE_KEY);
}

channel?.addEventListener("message", (event: MessageEvent<ChannelMessage>) => {
  const message = event.data;
  // 只交出属于请求方所见实例的凭证：服务端重启后旧标签页不会把失效凭证发给新标签页。
  if (message?.type === "request" && saved && saved.instanceId === message.instanceId && auth.get().phase === "ready") {
    channel.postMessage({ type: "credential", instanceId: saved.instanceId, credential: saved.credential, nonce: message.nonce } satisfies ChannelMessage);
  } else if (message?.type === "logout" && saved && message.credential === saved.credential) {
    toPairing("已在其他标签页退出登录");
  }
});

function toPairing(message?: string): void {
  store(null);
  auth.set({ phase: "pairing", instanceId: auth.get().instanceId, message });
}

async function instance(): Promise<string> {
  const response = await fetch("/api/instance", { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return (await response.json()).instanceId;
}

function ask(instanceId: string): Promise<string | null> {
  if (!channel) return Promise.resolve(null);
  const nonce = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { channel.removeEventListener("message", listener); resolve(null); }, ASK_TIMEOUT_MS);
    const listener = (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (message?.type === "credential" && message.nonce === nonce && message.instanceId === instanceId) {
        clearTimeout(timer); channel.removeEventListener("message", listener); resolve(message.credential);
      }
    };
    channel.addEventListener("message", listener);
    channel.postMessage({ type: "request", instanceId, nonce } satisfies ChannelMessage);
  });
}

setUnauthorizedHandler((body?: PaneErrorBody) => {
  if (auth.get().phase !== "ready") return;
  const changed = body?.instanceId && saved && body.instanceId !== saved.instanceId;
  toPairing(changed ? "pi-pane 服务端已重启，请重新配对" : "登录已失效，请重新配对");
});

export async function boot(): Promise<void> {
  auth.set({ phase: "loading" });
  let instanceId: string;
  try { instanceId = await instance(); }
  catch { auth.set({ phase: "unavailable", message: "无法连接 pi-pane 服务端" }); return; }
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (code) {
    history.replaceState(null, "", location.pathname + location.search);
    if (await pair(code, instanceId)) return;
    return;
  }
  const previous = load();
  if (previous && previous.instanceId === instanceId) { store(previous); auth.set({ phase: "ready", instanceId }); return; }
  if (previous) store(null);
  const shared = await ask(instanceId);
  if (shared) { store({ credential: shared, instanceId }); auth.set({ phase: "ready", instanceId }); return; }
  auth.set({ phase: "pairing", instanceId });
}

export async function pair(code: string, knownInstance?: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim() }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { auth.set({ phase: "pairing", instanceId: knownInstance, message: body.message ?? "配对失败" }); return false; }
    store({ credential: body.credential, instanceId: body.instanceId });
    auth.set({ phase: "ready", instanceId: body.instanceId });
    return true;
  } catch {
    auth.set({ phase: "pairing", instanceId: knownInstance, message: "无法连接 pi-pane 服务端" });
    return false;
  }
}

export async function logout(): Promise<void> {
  const current = saved;
  try { await api("/api/auth/logout", {}); } catch { /* 服务端不可用时仍清除本地凭证。 */ }
  if (current) channel?.postMessage({ type: "logout", credential: current.credential } satisfies ChannelMessage);
  toPairing("已退出登录");
}
