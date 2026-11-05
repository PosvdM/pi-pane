// pi-pane 鉴权客户端原型（architecture.md“配对码与会话凭证”“标签页之间共享凭证”“WebSocket”）。
// window.__f 暴露给测试驱动调用；页面加载时自动执行 boot()。
import * as device from './device-key.js';
import { canonicalize } from './jcs.js';
import { runJcsVectors, trickyPayload } from './jcs-vectors.js';

const STORAGE_KEY = 'pi-pane.auth';
const CHANNEL = 'pi-pane-auth';
const ASK_TIMEOUT_MS = 500;

const state = { phase: 'booting', events: [], ws: null, wsMessages: [], wsClose: null };
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel(CHANNEL) : null;
const ev = (type, data) => state.events.push({ type, ...data, at: Date.now() });

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function save(v) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
}
function clear(why) {
  sessionStorage.removeItem(STORAGE_KEY);
  ev('cleared', { why });
  state.phase = 'need-pair';
  render();
}

function render() {
  const el = document.getElementById('status');
  if (el) el.textContent = `${state.phase}`;
}

if (channel) {
  channel.onmessage = (e) => {
    const m = e.data;
    const mine = load();
    ev('bc-recv', { tag: `${m?.type}/${m?.nonce ?? '-'}` });
    if (m?.type === 'request' && mine && mine.instanceId === m.instanceId) {
      channel.postMessage({ type: 'credential', nonce: m.nonce, instanceId: mine.instanceId, token: mine.token });
      ev('bc-answered', { instanceId: m.instanceId });
    } else if (m?.type === 'request') {
      ev('bc-ignored', { theirs: m.instanceId, mine: mine?.instanceId ?? null });
    } else if (m?.type === 'logout' && mine && mine.token === m.token) {
      if (state.ws) state.ws.close();
      clear('bc-logout');
    }
  };
}

function askOtherTabs(instanceId) {
  if (!channel) return Promise.resolve(null);
  const nonce = crypto.getRandomValues(new Uint32Array(2)).join('-');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      channel.removeEventListener('message', onMsg);
      resolve(null);
    }, ASK_TIMEOUT_MS);
    function onMsg(e) {
      const m = e.data;
      if (m?.type === 'credential' && m.nonce === nonce && m.instanceId === instanceId) {
        clearTimeout(timer);
        channel.removeEventListener('message', onMsg);
        resolve({ token: m.token, instanceId: m.instanceId });
      }
    }
    channel.addEventListener('message', onMsg);
    channel.postMessage({ type: 'request', nonce, instanceId });
    ev('bc-asked', { instanceId });
  });
}

async function pair(code) {
  const r = await fetch('/api/auth/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const j = await r.json();
  if (r.status !== 200) {
    ev('pair-failed', { status: r.status });
    return false;
  }
  save({ token: j.token, instanceId: j.instanceId });
  ev('paired', { instanceId: j.instanceId });
  return true;
}

async function boot() {
  const inst = (await (await fetch('/api/instance')).json()).instanceId;
  state.instanceId = inst;
  let mine = load();
  if (mine && mine.instanceId !== inst) {
    clear('instance-changed-at-boot');
    mine = null;
  }
  const m = /(?:^#|&)code=([^&]+)/.exec(location.hash);
  if (m) {
    // 先从地址栏移除配对码，再兑换
    history.replaceState(null, '', location.pathname + location.search);
    if (await pair(decodeURIComponent(m[1]))) mine = load();
  }
  if (!mine) {
    const got = await askOtherTabs(inst);
    if (got) {
      save(got);
      ev('got-from-tab', {});
      mine = got;
    }
  }
  state.phase = mine ? 'ready' : 'need-pair';
  render();
  return state.phase;
}

async function api(path, init = {}) {
  const mine = load();
  const headers = { ...(init.headers ?? {}) };
  if (mine) headers.Authorization = `Bearer ${mine.token}`;
  const r = await fetch(path, { ...init, headers });
  const body = await r.json().catch(() => null);
  if (r.status === 401) {
    if (body?.instanceId && mine && body.instanceId !== mine.instanceId) clear('401-instance-changed');
    else clear('401');
  }
  return { status: r.status, body };
}

async function connectWs() {
  const t = await api('/api/ws-ticket', { method: 'POST' });
  if (t.status !== 200) return { ok: false, status: t.status };
  state.wsMessages = [];
  state.wsClose = null;
  const ws = new WebSocket(`ws://${location.host}/ws`);
  state.ws = ws;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws error'));
  });
  ws.onmessage = (e) => state.wsMessages.push(JSON.parse(e.data));
  ws.onclose = (e) => (state.wsClose = { code: e.code, reason: e.reason });
  ws.send(JSON.stringify({ type: 'auth', ticket: t.body.ticket }));
  const start = Date.now();
  while (!state.wsMessages.length && !state.wsClose && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
  return { ok: !!state.wsMessages.length, first: state.wsMessages[0] ?? null, close: state.wsClose };
}

async function logout() {
  const mine = load();
  const r = await api('/api/auth/logout', { method: 'POST' });
  if (channel && mine) channel.postMessage({ type: 'logout', token: mine.token });
  clear('logout');
  return r.status;
}

const booted = boot().catch((e) => {
  state.phase = 'boot-error';
  ev('boot-error', { message: String(e) });
});

window.__f = {
  ready: async () => (await booted, state.phase),
  boot,
  snapshot: () => ({
    phase: state.phase,
    href: location.href,
    hash: location.hash,
    hasCredential: !!load(),
    stored: load() ? { instanceId: load().instanceId } : null,
    events: state.events.map((e) => (e.why || e.tag ? `${e.type}:${e.why ?? e.tag}` : e.type)),
    wsMessages: state.wsMessages,
    wsClose: state.wsClose,
    cookie: document.cookie,
  }),
  token: () => load()?.token ?? null,
  whoami: () => api('/api/whoami'),
  connectWs,
  logout,
  pairManually: (code) => pair(code).then(() => boot()),
  // 设备密钥（#12、#16）
  support: () => device.detectSupport(),
  device: () => device.getOrCreateDevice().catch((e) => ({ error: e.code, message: e.message })),
  resetDevice: () => device.resetDevice().catch((e) => ({ error: e.code, message: e.message })),
  inspectKey: () => device.inspectPrivateKey().catch((e) => ({ error: e.code, message: e.message })),
  signPresence: (payload, opts) => device.signPresence(payload, opts).catch((e) => ({ error: e.code, message: e.message })),
  jcsVectors: () => runJcsVectors(canonicalize),
  trickyCanonical: () => canonicalize({ domain: 'pi-pane/user-presence/v1', payload: trickyPayload() }),
  ua: () => navigator.userAgent,
};
