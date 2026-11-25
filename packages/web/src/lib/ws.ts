// 事件通道：一条 WebSocket。先用 HTTP 取一次性 ticket，连接后首帧鉴权；断线后自动重连并按各订阅的游标续订。
import { api, ApiError } from "./api.ts";
import { Store } from "./store.ts";
import type { PaneServerMessage, SessionRef, SessionStreamEvent, StreamCursor, TreeChange, TreeCursor } from "./types.ts";

export type LinkState = "connecting" | "open" | "offline";
export const link = new Store<{ state: LinkState; connectionId?: string }>({ state: "connecting" });

interface Subscription { ref: SessionRef; cursor: () => StreamCursor; onEvent: (event: SessionStreamEvent) => void }
/** 会话订阅以完整的 (source, id) 区分，插件的同名会话不会覆盖主会话。 */
const subscriptions = new Map<string, Subscription>();
const keyOf = (ref: SessionRef) => ref.source + "\u0000" + ref.id;
interface TreeSubscription { cursor: () => TreeCursor | null; onChange: (change: TreeChange) => void }
const trees = new Map<string, TreeSubscription>();
const listeners = new Set<(message: PaneServerMessage) => void>();

let socket: WebSocket | null = null;
let generation = 0;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let lastPong = 0;
let running = false;

export function onMessage(listener: (message: PaneServerMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const subscribing = new Set<(id: string) => void>();
/** 每次向服务端发送订阅前通知：服务端会在订阅后重发全部待答对话框，收到通知的一方先清空本地副本。 */
export function onSubscribing(listener: (id: string) => void): () => void {
  subscribing.add(listener);
  return () => { subscribing.delete(listener); };
}
function sendSubscribe(subscription: Subscription): void {
  if (socket?.readyState !== WebSocket.OPEN || link.get().state !== "open") return;
  // 待答对话框只属于主会话；订阅前通知清空本地副本，由服务端重发。
  if (subscription.ref.source === "pane") for (const listener of subscribing) listener(subscription.ref.id);
  socket.send(JSON.stringify({ type: "subscribe", ref: subscription.ref, after: subscription.cursor() }));
}
function sendTreeSubscribe(source: string, subscription: TreeSubscription): void {
  const after = subscription.cursor();
  if (after) send({ type: "treeSubscribe", source, after });
}

/** 发送一帧；连接未就绪时丢弃，调用方依靠重连后的重新订阅或重新注册。 */
export function send(value: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN || link.get().state !== "open") return false;
  socket.send(JSON.stringify(value)); return true;
}

/** 订阅会话事件；连接恢复后按 cursor() 返回的游标重新订阅。字符串参数表示主会话 id。 */
export function subscribe(target: string | SessionRef, cursor: () => StreamCursor, onEvent: (event: SessionStreamEvent) => void): () => void {
  const ref = typeof target === "string" ? { source: "pane", id: target } : { source: target.source, id: target.id };
  const key = keyOf(ref); const subscription = { ref, cursor, onEvent };
  subscriptions.set(key, subscription);
  sendSubscribe(subscription);
  return () => {
    if (subscriptions.get(key) !== subscription) return;
    subscriptions.delete(key);
    send({ type: "unsubscribe", ref });
  };
}

/** 以新游标重新订阅（resync 之后）。字符串参数表示主会话 id。 */
export function resubscribe(target: string | SessionRef): void {
  const subscription = subscriptions.get(keyOf(typeof target === "string" ? { source: "pane", id: target } : target));
  if (subscription) sendSubscribe(subscription);
}

/** 订阅一个来源的会话树变更；连接恢复后按 cursor() 重新订阅，cursor() 为 null 表示该来源还没有快照。 */
export function subscribeTree(source: string, cursor: () => TreeCursor | null, onChange: (change: TreeChange) => void): () => void {
  const subscription = { cursor, onChange };
  trees.set(source, subscription);
  sendTreeSubscribe(source, subscription);
  return () => {
    if (trees.get(source) !== subscription) return;
    trees.delete(source);
    send({ type: "treeUnsubscribe", source });
  };
}
export function resubscribeTree(source: string): void {
  const subscription = trees.get(source);
  if (subscription) sendTreeSubscribe(source, subscription);
}

function schedule(): void {
  clearTimeout(retryTimer);
  if (!running) return;
  const delay = Math.min(5000, 300 * 2 ** retry++);
  retryTimer = setTimeout(() => { void connect(); }, delay);
}

function teardown(): void {
  clearInterval(heartbeat);
  const current = socket; socket = null; generation++;
  if (current) { current.onopen = current.onmessage = current.onclose = current.onerror = null; try { current.close(); } catch { /* 已关闭。 */ } }
  link.set({ state: "offline" });
}

async function connect(): Promise<void> {
  if (!running || socket) return;
  const mine = ++generation;
  link.set({ state: "connecting" });
  let ticket: string;
  try { ticket = (await api<{ ticket: string }>("/api/ws-ticket", {})).ticket; }
  catch (error) {
    if (mine !== generation) return;
    link.set({ state: "offline" });
    if (!(error instanceof ApiError && error.status === 401)) schedule();
    return;
  }
  if (mine !== generation || !running) return;
  const ws = new WebSocket(`ws://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", ticket, paneProtocol: [1, 1] }));
  ws.onmessage = (event) => {
    let message: PaneServerMessage;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "banners") {
      retry = 0; lastPong = Date.now();
      link.set({ state: "open", connectionId: message.connectionId });
      for (const subscription of subscriptions.values()) sendSubscribe(subscription);
      for (const [source, subscription] of trees) sendTreeSubscribe(source, subscription);
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        // 网络中断时浏览器可能长时间不触发 close；超过两个心跳周期没有回应就主动重连。
        if (Date.now() - lastPong > 25000) { teardown(); schedule(); return; }
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* close 回调处理。 */ }
      }, 10000);
    } else if (message.type === "pong") lastPong = Date.now();
    else if (message.type === "session") {
      lastPong = Date.now();
      subscriptions.get(keyOf(message.ref))?.onEvent(message);
    } else if (message.type === "tree") trees.get(message.source)?.onChange(message.change);
    for (const listener of listeners) listener(message);
  };
  ws.onclose = () => { if (socket !== ws) return; teardown(); schedule(); };
  ws.onerror = () => { /* close 回调处理重连。 */ };
}

export function start(): void {
  if (running) return;
  running = true; retry = 0; void connect();
}
export function stop(): void { running = false; clearTimeout(retryTimer); teardown(); }

addEventListener("offline", () => { if (running) teardown(); });
addEventListener("online", () => { if (running) { retry = 0; clearTimeout(retryTimer); void connect(); } });
