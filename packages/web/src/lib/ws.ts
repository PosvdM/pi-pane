// 事件通道：一条 WebSocket。先用 HTTP 取一次性 ticket，连接后首帧鉴权；断线后自动重连并按各订阅的游标续订。
import { api, ApiError } from "./api.ts";
import { Store } from "./store.ts";
import type { PaneServerMessage, SessionStreamEvent, StreamCursor } from "./types.ts";

export type LinkState = "connecting" | "open" | "offline";
export const link = new Store<{ state: LinkState; connectionId?: string }>({ state: "connecting" });

interface Subscription { cursor: () => StreamCursor; onEvent: (event: SessionStreamEvent) => void }
const subscriptions = new Map<string, Subscription>();
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

function send(value: unknown): void { if (socket?.readyState === WebSocket.OPEN && link.get().state === "open") socket.send(JSON.stringify(value)); }

/** 订阅会话事件；连接恢复后按 cursor() 返回的游标重新订阅。 */
export function subscribe(id: string, cursor: () => StreamCursor, onEvent: (event: SessionStreamEvent) => void): () => void {
  const subscription = { cursor, onEvent };
  subscriptions.set(id, subscription);
  send({ type: "subscribe", ref: { source: "pane", id }, after: cursor() });
  return () => {
    if (subscriptions.get(id) !== subscription) return;
    subscriptions.delete(id);
    send({ type: "unsubscribe", ref: { source: "pane", id } });
  };
}

/** 以新游标重新订阅（resync 之后）。 */
export function resubscribe(id: string): void {
  const subscription = subscriptions.get(id);
  if (subscription) send({ type: "subscribe", ref: { source: "pane", id }, after: subscription.cursor() });
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
      for (const [id, subscription] of subscriptions) ws.send(JSON.stringify({ type: "subscribe", ref: { source: "pane", id }, after: subscription.cursor() }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        // 网络中断时浏览器可能长时间不触发 close；超过两个心跳周期没有回应就主动重连。
        if (Date.now() - lastPong > 25000) { teardown(); schedule(); return; }
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* close 回调处理。 */ }
      }, 10000);
    } else if (message.type === "pong") lastPong = Date.now();
    else if (message.type === "session") {
      lastPong = Date.now();
      subscriptions.get(message.ref.id)?.onEvent(message);
    }
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
