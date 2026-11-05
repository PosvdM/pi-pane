import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WsConnection } from '../lib/ws.mjs';

/** 发 HTTP 请求，可任意设置 Host、Origin 等头（fetch 不允许改 Host）。 */
export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        setHost: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** 原始 WebSocket 握手，可任意设置头。成功返回 { conn, messages }，失败返回 { status, text }。 */
export function wsConnect(port, { path = '/ws', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      setHost: false,
      headers: {
        Host: `127.0.0.1:${port}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket, head) => {
      const conn = new WsConnection(socket, { isClient: true });
      const messages = [];
      const closed = new Promise((r) => conn.on('close', (code, reason) => r({ code, reason, at: Date.now() })));
      conn.on('message', (m) => messages.push({ m, at: Date.now() }));
      if (head.length) socket.emit('data', head);
      resolve({ conn, messages, closed, openedAt: Date.now() });
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function waitFor(fn, { timeoutMs = 3000, stepMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v;
      try {
        v = fn();
      } catch (e) {
        return reject(e);
      }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/** 打印一行可在 RESULTS.md 引用的观察记录。 */
export function note(t, label, value) {
  const line = `[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  if (t?.diagnostic) t.diagnostic(line);
  else console.log(line);
}
