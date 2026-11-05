// pi-pane 鉴权原型（pane P0 #11），按 docs/architecture.md“鉴权”一节实现：
// - 只监听 127.0.0.1；Host 必须正好是 127.0.0.1:<port>；带 Origin 时必须是规范源；不开放 CORS。
// - 配对码（80 位随机数，一次性，10 分钟过期，连续输错 5 次作废）换会话凭证。
// - 会话凭证只在内存，Authorization: Bearer 发送，24 小时无活动失效，可吊销；不发 Set-Cookie。
// - WebSocket：先 POST /api/ws-ticket 取 30 秒一次性 ticket，首帧 {type:"auth",ticket}，5 秒内无有效首帧即关闭；
//   首帧之前不推送数据，鉴权后先发 banners。
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
  } = opts;

  const instanceId = rand(12);
  const codes = new Map(); // code -> { createdAt, failures, state: 'active'|'used'|'burned' }
  const creds = new Map(); // token -> { createdAt, lastUsed }
  const tickets = new Map(); // ticket -> { token, expiresAt }
  const sockets = new Set(); // { conn, token }
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

  function bearer(req) {
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const c = creds.get(m[1]);
    if (!c) return null;
    if (now() - c.lastUsed > idleMs) {
      revoke(m[1], 'idle');
      return null;
    }
    c.lastUsed = now();
    return m[1];
  }

  function revoke(token, why) {
    creds.delete(token);
    for (const [t, v] of tickets) if (v.token === token) tickets.delete(t);
    for (const s of sockets) {
      if (s.token === token) {
        s.conn.close(4403, `revoked:${why}`);
        sockets.delete(s);
      }
    }
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
    let authed = false;
    const timer = setTimeout(() => {
      entry.auth = 'timeout';
      conn.close(4401, 'auth timeout');
    }, wsAuthTimeoutMs);
    conn.on('close', () => {
      clearTimeout(timer);
      for (const s of sockets) if (s.conn === conn) sockets.delete(s);
    });
    conn.on('message', (text) => {
      if (!authed) {
        clearTimeout(timer);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          msg = null;
        }
        const t = msg?.type === 'auth' && typeof msg.ticket === 'string' ? tickets.get(msg.ticket) : null;
        if (t) tickets.delete(msg.ticket); // 一次性：查到就作废，无论是否过期
        if (!t || t.expiresAt < now() || !creds.has(t.token)) {
          entry.auth = !msg || msg.type !== 'auth' ? 'bad_first_frame' : !t ? 'unknown_ticket' : 'expired_ticket';
          return conn.close(4401, entry.auth);
        }
        authed = true;
        entry.auth = 'ok';
        sockets.add({ conn, token: t.token });
        conn.send(JSON.stringify({ type: 'banners', banners }));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'ping') conn.send(JSON.stringify({ type: 'pong', n: msg.n }));
    });
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
    revoke,
    async close() {
      for (const s of sockets) s.conn.close(1001, 'server shutdown');
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
