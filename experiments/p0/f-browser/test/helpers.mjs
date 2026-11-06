import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsConnection, encodeFrame } from '../lib/ws.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
      // 把多个文本帧拼成一次 TCP 写入，用于“同一批数据里紧跟着的帧”这类反例。
      const sendBatch = (texts) => socket.write(Buffer.concat(texts.map((x) => encodeFrame(0x1, x, { mask: true }))));
      resolve({ conn, messages, closed, sendBatch, openedAt: Date.now() });
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

/** 条件等待：fn 可返回 Promise；超过截止时间抛错。 */
export async function waitFor(fn, { timeoutMs = 10_000, stepMs = 20, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`);
    await sleep(stepMs);
  }
}

/** 在截止时间内等待 Promise，超时抛错（不改变被等待的操作）。 */
export function within(promise, timeoutMs, what = 'promise') {
  let h;
  return Promise.race([
    promise,
    new Promise((_, rej) => (h = setTimeout(() => rej(new Error(`deadline ${timeoutMs}ms: ${what}`)), timeoutMs))),
  ]).finally(() => clearTimeout(h));
}

/**
 * 可控时钟：now() 返回虚拟时间；setTimeout/clearTimeout 登记在虚拟时间上，
 * advance(ms) 推进时间并按到期顺序同步执行到期的回调。
 */
export function fakeClock(start = Date.now()) {
  let t = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingCount: () => pending.size,
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
      return t;
    },
  };
}

// ---------------------------------------------------------------- 证据

const evidence = [];
const testFile = path.basename(process.argv[1] ?? 'unknown', '.mjs');
let evidenceHooked = false;

/** 证据文件位置：默认写到被忽略的 .evidence/，每次运行独立命名；P0_RECORD=1 时刷新已提交的 evidence/。 */
export function evidencePath() {
  if (process.env.P0_RECORD === '1') return path.join(ROOT, 'evidence', `${testFile}.json`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, '.evidence', `${testFile}-${stamp}-${process.pid}.json`);
}

function hookEvidence() {
  if (evidenceHooked) return;
  evidenceHooked = true;
  process.on('exit', () => {
    if (!evidence.length) return;
    const file = evidencePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ file: testFile, node: process.version, platform: process.platform, notes: evidence }, null, 2) + '\n');
  });
}

/** 打印一行可在 RESULTS.md 引用的观察记录，并写入证据文件。 */
export function note(t, label, value) {
  hookEvidence();
  evidence.push({ test: t?.fullName ?? t?.name ?? null, label, value });
  const line = `[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  if (t?.diagnostic) t.diagnostic(line);
  else console.log(line);
}
