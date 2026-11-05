// pane P0 #11 的服务端部分：用 Node.js 直接发请求，覆盖浏览器发不出来的头（Host、Origin: null 等）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAuthServer } from '../lib/auth-server.mjs';
import { request, wsConnect, sleep, note } from './helpers.mjs';

async function withServer(opts, fn) {
  let clock = Date.now();
  const s = await startAuthServer({ now: () => clock, ...opts });
  const ctl = { s, advance: (ms) => (clock += ms) };
  try {
    await fn(ctl);
  } finally {
    await s.close();
  }
}

async function pair(s) {
  const code = s.newPairCode();
  const r = await request(s.port, { method: 'POST', path: '/api/auth/pair', body: { code }, headers: { Origin: s.origin } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

test('Host 必须正好是 127.0.0.1:<port>', async (t) => {
  await withServer({}, async ({ s }) => {
    const p = s.port;
    const cases = {
      [`127.0.0.1:${p}`]: 200,
      [`localhost:${p}`]: 403,
      [`LOCALHOST:${p}`]: 403,
      [`localhost.:${p}`]: 403,
      ['127.0.0.1']: 403,
      [`127.0.0.1:${p + 1}`]: 403,
      [`evil.test:${p}`]: 403,
      [`[::1]:${p}`]: 403,
      [`127.1:${p}`]: 403,
      [`2130706433:${p}`]: 403,
    };
    const got = {};
    for (const [host, want] of Object.entries(cases)) {
      for (const path of ['/api/instance', '/']) {
        const r = await request(p, { path, headers: { Host: host } });
        got[`${host} ${path}`] = r.status;
        assert.equal(r.status, want, `${host} ${path}`);
      }
    }
    // 没有 Host 头（HTTP/1.1 不合法，但仍要拒绝）
    const r = await request(p, { path: '/api/instance', headers: { Host: '' } });
    got['(empty) /api/instance'] = r.status;
    assert.notEqual(r.status, 200);
    note(t, 'host-matrix', got);
  });
});

test('带 Origin 时必须是规范源；不开放 CORS', async (t) => {
  await withServer({}, async ({ s }) => {
    const p = s.port;
    const cases = {
      [s.origin]: 200,
      [`http://127.0.0.1:${p + 1}`]: 403,
      [`http://localhost:${p}`]: 403,
      [`https://127.0.0.1:${p}`]: 403,
      null: 403,
      [`http://127.0.0.1:${p}/`]: 403,
    };
    const got = {};
    for (const [origin, want] of Object.entries(cases)) {
      const r = await request(p, { path: '/api/instance', headers: { Origin: origin } });
      got[origin] = r.status;
      assert.equal(r.status, want, origin);
      assert.equal(
        Object.keys(r.headers).filter((h) => h.startsWith('access-control-')).length,
        0,
        'no CORS headers',
      );
    }
    // 跨源预检
    const pre = await request(p, {
      method: 'OPTIONS',
      path: '/api/ws-ticket',
      headers: { Origin: `http://127.0.0.1:${p + 1}`, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    got['OPTIONS cross-origin'] = pre.status;
    assert.equal(pre.status, 403);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    note(t, 'origin-matrix', got);
  });
});

test('所有响应带安全头，且没有 Set-Cookie', async (t) => {
  await withServer({}, async ({ s }) => {
    const token = await pair(s);
    const reqs = [
      { path: '/' },
      { path: '/app.js' },
      { path: '/api/instance' },
      { path: '/api/whoami' },
      { path: '/api/whoami', headers: { Authorization: `Bearer ${token}` } },
      { path: '/api/whoami', headers: { Host: 'localhost:1' } },
      { method: 'POST', path: '/api/auth/pair', body: { code: 'nope' } },
      { method: 'POST', path: '/api/ws-ticket', headers: { Authorization: `Bearer ${token}` } },
      { path: '/nope' },
    ];
    const statuses = [];
    for (const r0 of reqs) {
      const r = await request(s.port, r0);
      statuses.push(`${r0.method ?? 'GET'} ${r0.path} -> ${r.status}`);
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    }
    note(t, 'headers-checked', statuses);
  });
});

test('配对码：一次性、10 分钟过期、连续输错 5 次作废；跨源的错误尝试不计数', async (t) => {
  await withServer({}, async ({ s, advance }) => {
    const pairReq = (code, origin = s.origin) =>
      request(s.port, { method: 'POST', path: '/api/auth/pair', body: { code }, headers: { Origin: origin } });

    // 格式与熵
    const c0 = s.newPairCode();
    assert.match(c0, /^[0-9a-f]{20}$/);
    note(t, 'code-format', `${c0.length} hex chars = 80 bits`);

    // 正确 → 凭证与 instanceId；再用一次失败
    const ok = await pairReq(c0);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.instanceId, s.instanceId);
    assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await pairReq(c0)).status, 401);

    // 10 分钟过期
    const c1 = s.newPairCode();
    advance(10 * 60_000 + 1);
    assert.equal((await pairReq(c1)).status, 401);

    // 输错 4 次后仍可用
    const c2 = s.newPairCode();
    for (let i = 0; i < 4; i++) assert.equal((await pairReq('wrong' + i)).status, 401);
    assert.equal((await pairReq(c2)).status, 200);

    // 输错 5 次后作废
    const c3 = s.newPairCode();
    for (let i = 0; i < 5; i++) await pairReq('wrong' + i);
    assert.equal(s.codeState(c3).state, 'burned');
    assert.equal((await pairReq(c3)).status, 401);

    // 跨源页面的猜测在 Origin 检查处被拒，不消耗输错次数
    const c4 = s.newPairCode();
    for (let i = 0; i < 10; i++) assert.equal((await pairReq('x' + i, 'http://127.0.0.1:1')).status, 403);
    assert.equal(s.codeState(c4).failures, 0);
    // 不带 Origin（非浏览器客户端）的猜测计数
    await pairReq('y', undefined);
    assert.equal(s.codeState(c4).failures, 1);
    assert.equal((await pairReq(c4)).status, 200);
  });
});

test('Bearer 凭证：缺失/无效 401 并带 instanceId；24 小时无活动失效；退出登录立即吊销', async (t) => {
  await withServer({}, async ({ s, advance }) => {
    const r0 = await request(s.port, { path: '/api/whoami' });
    assert.equal(r0.status, 401);
    assert.equal(r0.json.instanceId, s.instanceId);

    const token = await pair(s);
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await request(s.port, { path: '/api/whoami', headers: auth })).status, 200);
    // Cookie 不起作用
    assert.equal((await request(s.port, { path: '/api/whoami', headers: { Cookie: `token=${token}` } })).status, 401);
    // 凭证放在 URL 里不起作用
    assert.equal((await request(s.port, { path: `/api/whoami?token=${token}` })).status, 401);

    advance(23 * 3600_000);
    assert.equal((await request(s.port, { path: '/api/whoami', headers: auth })).status, 200, 'activity resets idle');
    advance(24 * 3600_000 + 1);
    assert.equal((await request(s.port, { path: '/api/whoami', headers: auth })).status, 401, 'idle 24h');

    const t2 = await pair(s);
    const a2 = { Authorization: `Bearer ${t2}` };
    assert.equal((await request(s.port, { method: 'POST', path: '/api/auth/logout', headers: a2 })).status, 200);
    assert.equal((await request(s.port, { path: '/api/whoami', headers: a2 })).status, 401);
  });
});

test('服务端重启：新 instanceId，旧凭证 401 且响应说明 instanceId 已变', async (t) => {
  const s1 = await startAuthServer({});
  const token = await pair(s1);
  const port = s1.port;
  const old = s1.instanceId;
  await s1.close();
  const s2 = await startAuthServer({ port });
  try {
    assert.notEqual(s2.instanceId, old);
    const r = await request(port, { path: '/api/whoami', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 401);
    assert.equal(r.json.instanceId, s2.instanceId);
    note(t, 'restart', { old, new: s2.instanceId, status: r.status, body: r.json });
  } finally {
    await s2.close();
  }
});

test('WebSocket 握手校验 Host 和 Origin', async (t) => {
  await withServer({}, async ({ s }) => {
    const p = s.port;
    const got = {};
    for (const [label, headers, want] of [
      ['canonical', { Origin: s.origin }, 101],
      ['no-origin', {}, 101],
      ['other-port-origin', { Origin: `http://127.0.0.1:${p + 1}` }, 403],
      ['localhost-host', { Host: `localhost:${p}`, Origin: `http://localhost:${p}` }, 403],
      ['localhost-host-canonical-origin', { Host: `localhost:${p}`, Origin: s.origin }, 403],
      ['null-origin', { Origin: 'null' }, 403],
    ]) {
      const r = await wsConnect(p, { headers });
      const status = r.conn ? 101 : r.status;
      got[label] = status;
      assert.equal(status, want, label);
      if (r.conn) r.conn.close();
    }
    note(t, 'ws-handshake', got);
  });
});

test('WebSocket 首帧 ticket：一次性、30 秒有效、首帧前不推送、鉴权后先发 banners', async (t) => {
  await withServer({}, async ({ s, advance }) => {
    const token = await pair(s);
    const auth = { Authorization: `Bearer ${token}` };
    const ticket = async () => (await request(s.port, { method: 'POST', path: '/api/ws-ticket', headers: auth })).json.ticket;

    // 正常流程
    const tk = await ticket();
    const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
    await sleep(300);
    assert.equal(w.messages.length, 0, 'no data before auth');
    w.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
    await sleep(100);
    assert.equal(JSON.parse(w.messages[0].m).type, 'banners');
    w.conn.send(JSON.stringify({ type: 'ping', n: 1 }));
    await sleep(100);
    assert.equal(JSON.parse(w.messages[1].m).type, 'pong');
    note(t, 'ws-ok-first-message', w.messages[0].m);

    // 同一 ticket 再用
    const w2 = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w2.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
    const c2 = await w2.closed;
    assert.equal(c2.code, 4401);
    assert.equal(w2.messages.length, 0);

    // 首帧不是 auth：在首帧里发其他消息，服务端不处理并关闭
    const tk3 = await ticket();
    const w3 = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w3.conn.send(JSON.stringify({ type: 'ping', n: 1, ticket: tk3 }));
    const c3 = await w3.closed;
    assert.equal(c3.code, 4401);
    assert.equal(w3.messages.length, 0);

    // ticket 放在 URL 里无效（仍需首帧）
    const tk4 = await ticket();
    const w4 = await wsConnect(s.port, { path: `/ws?ticket=${tk4}`, headers: { Origin: s.origin } });
    assert.ok(w4.conn, 'handshake ok');
    w4.conn.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await w4.closed).code, 4401);

    // 过期 ticket
    const tk5 = await ticket();
    advance(30_001);
    const w5 = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w5.conn.send(JSON.stringify({ type: 'auth', ticket: tk5 }));
    const c5 = await w5.closed;
    assert.equal(c5.code, 4401);
    assert.equal(c5.reason, 'expired_ticket');

    // 吊销凭证后已建立的连接被关闭
    const r = await request(s.port, { method: 'POST', path: '/api/auth/logout', headers: auth });
    assert.equal(r.status, 200);
    const c1 = await w.closed;
    assert.equal(c1.code, 4403);
    note(t, 'ws-close-codes', { reuse: c2, notAuth: c3, expired: c5, revoked: c1 });
  });
});

test('WebSocket：5 秒内没有首帧即关闭', async (t) => {
  await withServer({}, async ({ s }) => {
    const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
    const c = await w.closed;
    const ms = c.at - w.openedAt;
    note(t, 'ws-timeout', { code: c.code, reason: c.reason, ms });
    assert.equal(c.code, 4401);
    assert.ok(ms >= 4900 && ms < 6500, `closed after ${ms}ms`);
    assert.equal(w.messages.length, 0);
  });
});
