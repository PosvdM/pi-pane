// pi-pane 鉴权原型（pane P0 #11），按 docs/architecture.md“鉴权”一节实现：
// - 只监听 127.0.0.1；Host 必须正好是 127.0.0.1:<port>；带 Origin 时必须是规范源；不开放 CORS。
// - 配对码（80 位随机数，一次性，10 分钟过期，连续输错 5 次作废）换会话凭证。
// - 会话凭证只在内存，Authorization: Bearer 发送，24 小时无活动失效，可吊销；不发 Set-Cookie。
//   HTTP 请求、WebSocket 首帧和已鉴权连接上的业务帧都走 useCredential()：同一套空闲过期检查，
//   有效时记为活动。sweep() 定期吊销空闲过期的凭证并关闭它们的连接。
// - WebSocket：先 POST /api/ws-ticket 取 30 秒一次性 ticket，首帧 {type:"auth",ticket}，5 秒内无有效首帧即关闭；
//   首帧之前不推送数据，鉴权后先发 banners。连接状态 pending → authed，或进入终态 rejected / closing；
//   终态下不再分发任何帧、不再发送数据。
// 单独运行：node lib/auth-server.mjs [port]，终端打印配对地址，按 Enter 生成新配对码。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade, rejectUpgrade } from './ws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const rand = (n) => randomBytes(n).toString('base64url');

export function cspFor(port) {
  return (
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; " +
    `connect-src 'self' ws://127.0.0.1:${port}`
  );
}

export async function startAuthServer(opts = {}) {
  const {
    port = 0,
    publicDir = PUBLIC_DIR,
    now = () => Date.now(),
    pairTtlMs = 10 * 60_000,
    idleMs = 24 * 3600_000,
    ticketTtlMs = 30_000,
    wsAuthTimeoutMs = 5000,
    maxPairFailures = 5,
    banners = [{ id: 'demo', text: 'prototype banner' }],
    // 可注入的定时器，测试用可控时钟驱动 5 秒首帧超时。
    timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
    // 定期清理空闲凭证并关闭其 WebSocket；0 表示不启动（测试里手动调用 sweep）。
    sweepIntervalMs = 60_000,
  } = opts;

  const instanceId = rand(12);
  const codes = new Map(); // code -> { createdAt, failures, state: 'active'|'used'|'burned' }
  const creds = new Map(); // token -> { createdAt, lastUsed }
  const tickets = new Map(); // ticket -> { token, expiresAt }
  // 已建立的 WebSocket：{ conn, entry, token, state }。
  // state：pending（等首帧）→ authed；首帧无效或超时 → rejected；
  // 已鉴权的连接被吊销、空闲过期或服务端关闭 → closing。rejected 和 closing 是终态。
  const sockets = new Set();
  const log = [];
  let actualPort = port;
  let host = '';
  let origin = '';

  const common = () => ({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': cspFor(actualPort),
  });

  function newPairCode() {
    const code = randomBytes(10).toString('hex'); // 80 位
    codes.set(code, { createdAt: now(), failures: 0, state: 'active' });
    return code;
  }

  function activeCodes() {
    const out = [];
    for (const [code, c] of codes) {
      if (c.state === 'active' && now() - c.createdAt > pairTtlMs) c.state = 'expired';
      if (c.state === 'active') out.push([code, c]);
    }
    return out;
  }

  function checkHostOrigin(req) {
    if (req.headers.host !== host) return 'bad_host';
    const o = req.headers.origin;
    if (o !== undefined && o !== origin) return 'bad_origin';
    return null;
  }

  /**
   * HTTP 和 WebSocket 共用的凭证规则：凭证存在且距上次活动不超过 idleMs 才有效；
   * 有效时把本次调用记为活动，过期时吊销（并关闭它的 WebSocket）。返回无效原因或 null。
   */
  function useCredential(token) {
    const c = creds.get(token);
    if (!c) return 'unknown_credential';
    if (now() - c.lastUsed > idleMs) {
      revoke(token, 'idle');
      return 'credential_idle_expired';
    }
    c.lastUsed = now();
    return null;
  }

  function bearer(req) {
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    return useCredential(m[1]) ? null : m[1];
  }

  function closeSocket(s, state, code, reason) {
    if (s.state === 'rejected' || s.state === 'closing') return;
    s.state = state;
    s.entry.state = state;
    s.entry.closeReason = reason;
    if (s.timer) timers.clearTimeout(s.timer);
    s.conn.close(code, reason);
  }

  /** 只在 authed 状态发送；其他状态的发送尝试计入 entry.sendBlocked。 */
  function sendTo(s, obj) {
    if (s.state !== 'authed' || !s.conn.send(JSON.stringify(obj))) {
      s.entry.sendBlocked = (s.entry.sendBlocked ?? 0) + 1;
      return false;
    }
    s.entry.sent = (s.entry.sent ?? 0) + 1;
    return true;
  }

  function revoke(token, why) {
    creds.delete(token);
    for (const [t, v] of tickets) if (v.token === token) tickets.delete(t);
    for (const s of sockets) if (s.token === token) closeSocket(s, 'closing', 4403, `revoked:${why}`);
  }

  /** 清理已空闲过期的凭证，关闭它们的 WebSocket。只检查，不记为活动。 */
  function sweep() {
    const expired = [];
    for (const [token, c] of creds) if (now() - c.lastUsed > idleMs) expired.push(token);
    for (const token of expired) revoke(token, 'idle');
    return expired.length;
  }

  function send(res, status, body, extra = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...common(), 'Content-Type': 'application/json', ...extra });
    res.end(text);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 65536) throw new Error('too large');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const entry = {
      t: now(),
      method: req.method,
      path: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      secFetchSite: req.headers['sec-fetch-site'],
      secFetchMode: req.headers['sec-fetch-mode'],
      hasAuthorization: !!req.headers.authorization,
      cookie: req.headers.cookie,
    };
    log.push(entry);
    const done = (status, reason, body, extra) => {
      entry.status = status;
      entry.reason = reason;
      send(res, status, body, extra);
    };

    const bad = checkHostOrigin(req);
    if (bad) return done(403, bad, { error: bad });

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-z0-9-]+\.(html|js|css)$/.test(name)) return done(404, 'not_found', { error: 'not_found' });
      try {
        const body = await readFile(path.join(publicDir, name));
        entry.status = 200;
        res.writeHead(200, { ...common(), 'Content-Type': MIME[path.extname(name)] });
        return res.end(body);
      } catch {
        return done(404, 'not_found', { error: 'not_found' });
      }
    }

    if (req.method === 'OPTIONS') return done(405, 'no_cors', { error: 'method_not_allowed' });

    if (req.method === 'GET' && url.pathname === '/api/instance') return done(200, 'ok', { instanceId });

    if (req.method === 'POST' && url.pathname === '/api/auth/pair') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return done(400, 'bad_json', { error: 'bad_request' });
      }
      const active = activeCodes();
      const hit = active.find(([code]) => code === body.code);
      if (hit) {
        hit[1].state = 'used';
        const token = rand(32);
        creds.set(token, { createdAt: now(), lastUsed: now() });
        return done(200, 'paired', { token, instanceId });
      }
      // 输错计入所有仍有效的配对码：服务端无法知道对方在猜哪一个。
      for (const [, c] of active) {
        c.failures += 1;
        if (c.failures >= maxPairFailures) c.state = 'burned';
      }
      return done(401, 'invalid_code', { error: 'invalid_code' });
    }

    if (url.pathname.startsWith('/api/')) {
      const token = bearer(req);
      if (!token) return done(401, 'unauthorized', { error: 'unauthorized', instanceId });
      if (req.method === 'GET' && url.pathname === '/api/whoami') return done(200, 'ok', { ok: true, instanceId });
      if (req.method === 'POST' && url.pathname === '/api/ws-ticket') {
        const ticket = rand(24);
        tickets.set(ticket, { token, expiresAt: now() + ticketTtlMs });
        return done(200, 'ticket', { ticket, expiresInMs: ticketTtlMs });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        revoke(token, 'logout');
        return done(200, 'logout', { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/pair-code') {
        return done(200, 'pair-code', { code: newPairCode() });
      }
    }
    return done(404, 'not_found', { error: 'not_found' });
  }

  function onUpgrade(req, socket, head) {
    const entry = {
      t: now(),
      kind: 'ws',
      path: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      hasAuthorization: !!req.headers.authorization,
      cookie: req.headers.cookie,
    };
    log.push(entry);
    socket.on('error', () => {});
    const bad = checkHostOrigin(req);
    const pathOk = new URL(req.url, 'http://x').pathname === '/ws';
    if (bad || !pathOk || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      entry.status = 403;
      entry.reason = bad ?? 'bad_path';
      return rejectUpgrade(socket, 403, { error: entry.reason }, common());
    }
    entry.status = 101;
    const conn = acceptUpgrade(req, socket, head);
    const s = { conn, entry, token: null, state: 'pending', timer: null };
    entry.state = 'pending';
    entry.dropped = 0;
    sockets.add(s);
    s.timer = timers.setTimeout(() => {
      s.timer = null;
      if (s.state !== 'pending') return;
      entry.auth = 'timeout';
      closeSocket(s, 'rejected', 4401, 'auth timeout');
    }, wsAuthTimeoutMs);
    conn.on('close', () => {
      if (s.timer) timers.clearTimeout(s.timer);
      sockets.delete(s);
      entry.droppedAfterClose = conn.droppedAfterClose;
    });
    conn.on('message', (text) => {
      if (s.state === 'pending') return onFirstFrame(s, text);
      if (s.state !== 'authed') {
        // rejected / closing 是终态：不分发任何帧。
        entry.dropped += 1;
        return;
      }
      // 已鉴权连接上的每个业务帧都按 HTTP 的同一规则检查并更新凭证活动时间。
      const why = useCredential(s.token);
      if (why) {
        entry.dropped += 1;
        return closeSocket(s, 'closing', 4401, why);
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'ping') sendTo(s, { type: 'pong', n: msg.n });
    });
  }

  function onFirstFrame(s, text) {
    if (s.timer) timers.clearTimeout(s.timer);
    s.timer = null;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      msg = null;
    }
    const isAuth = msg?.type === 'auth' && typeof msg.ticket === 'string';
    const t = isAuth ? tickets.get(msg.ticket) : null;
    if (t) tickets.delete(msg.ticket); // 一次性：查到就作废，无论是否有效
    let why = null;
    if (!isAuth) why = 'bad_first_frame';
    else if (!t) why = 'unknown_ticket';
    else if (t.expiresAt < now()) why = 'expired_ticket';
    else why = useCredential(t.token); // 与 HTTP 相同：空闲过期即拒绝，有效则记为活动
    if (why) {
      s.entry.auth = why;
      return closeSocket(s, 'rejected', 4401, why);
    }
    s.state = 'authed';
    s.entry.state = 'authed';
    s.entry.auth = 'ok';
    s.token = t.token;
    sendTo(s, { type: 'banners', banners });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        send(res, 500, { error: 'internal', message: String(e) });
      } catch {}
    });
  });
  server.on('upgrade', onUpgrade);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  const sweeper = sweepIntervalMs > 0 ? setInterval(sweep, sweepIntervalMs) : null;
  sweeper?.unref();
  host = `127.0.0.1:${actualPort}`;
  origin = `http://${host}`;

  return {
    port: actualPort,
    host,
    origin,
    instanceId,
    log,
    newPairCode,
    codeState: (code) => ({ ...codes.get(code) }),
    credentialCount: () => creds.size,
    socketCount: () => sockets.size,
    socketStates: () => [...sockets].map((x) => x.state),
    revoke,
    sweep,
    async close() {
      if (sweeper) clearInterval(sweeper);
      for (const s of sockets) closeSocket(s, 'closing', 1001, 'server shutdown');
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startAuthServer({ port: Number(process.argv[2] ?? 4319) });
  const show = () => console.log(`配对地址：${s.origin}/#code=${s.newPairCode()}`);
  console.log(`pi-pane 鉴权原型：${s.origin}（instanceId ${s.instanceId}）`);
  show();
  console.log('按 Enter 生成新配对码，Ctrl+C 退出。');
  process.stdin.on('data', show);
}
