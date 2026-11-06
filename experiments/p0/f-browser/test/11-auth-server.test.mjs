// pane P0 #11 的服务端部分：用 Node.js 直接发请求，覆盖浏览器发不出来的头（Host、Origin: null 等）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAuthServer } from '../lib/auth-server.mjs';
import { request, wsConnect, waitFor, within, fakeClock, note } from './helpers.mjs';

// 服务端的时间（凭证、ticket、配对码过期）和 5 秒首帧定时器都走可控时钟；
// 测试只在真实墙钟上等待网络往返，并且都用条件等待加截止时间。
async function withServer(opts, fn) {
  const clock = fakeClock();
  const s = await startAuthServer({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    sweepIntervalMs: 0,
    ...opts,
  });
  const ctl = { s, clock, advance: (ms) => clock.advance(ms) };
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

const DEADLINE = 10_000;
const msgs = (w) => w.messages.map((x) => JSON.parse(x.m));
const closedOf = (w, what) => within(w.closed, DEADLINE, what);

async function ticketFor(s, token) {
  const r = await request(s.port, { method: 'POST', path: '/api/ws-ticket', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, r.text);
  return r.json.ticket;
}

/** 服务端日志里这条连接的记录（按连接顺序）。 */
const wsEntries = (s) => s.log.filter((e) => e.kind === 'ws' && e.status === 101);

test('WebSocket 首帧 ticket：一次性、30 秒有效、首帧前不推送、鉴权后先发 banners', async (t) => {
  await withServer({}, async ({ s, advance }) => {
    const token = await pair(s);
    const auth = { Authorization: `Bearer ${token}` };

    // 正常流程。首帧前不推送：TCP 按序到达，若服务端在首帧前发过任何数据，第一条消息就不会是 banners。
    const tk = await ticketFor(s, token);
    const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
    await waitFor(() => s.socketStates().includes('pending'), { what: 'server registered pending socket' });
    w.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
    await waitFor(() => w.messages.length >= 1, { what: 'banners' });
    assert.equal(msgs(w)[0].type, 'banners');
    w.conn.send(JSON.stringify({ type: 'ping', n: 1 }));
    await waitFor(() => w.messages.length >= 2, { what: 'pong' });
    assert.equal(msgs(w)[1].type, 'pong');
    assert.equal(wsEntries(s)[0].sendBlocked, undefined, 'no send attempted outside authed');
    note(t, 'ws-ok-first-message', w.messages[0].m);

    // 同一 ticket 再用
    const w2 = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w2.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
    const c2 = await closedOf(w2, 'reuse close');
    assert.equal(c2.code, 4401);
    assert.equal(w2.messages.length, 0);

    // 首帧不是 auth
    const tk3 = await ticketFor(s, token);
    const w3 = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w3.conn.send(JSON.stringify({ type: 'ping', n: 1, ticket: tk3 }));
    const c3 = await closedOf(w3, 'not-auth close');
    assert.equal(c3.code, 4401);
    assert.equal(w3.messages.length, 0);

    // ticket 放在 URL 里无效（仍需首帧）
    const tk4 = await ticketFor(s, token);
    const w4 = await wsConnect(s.port, { path: `/ws?ticket=${tk4}`, headers: { Origin: s.origin } });
    assert.ok(w4.conn, 'handshake ok');
    w4.conn.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await closedOf(w4, 'url-ticket close')).code, 4401);

    // 过期 ticket（可控时钟前进 30 秒 + 1 毫秒）
    const tk5 = await ticketFor(s, token);
    advance(30_001);
    const w5 = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w5.conn.send(JSON.stringify({ type: 'auth', ticket: tk5 }));
    const c5 = await closedOf(w5, 'expired close');
    assert.equal(c5.code, 4401);
    assert.equal(c5.reason, 'expired_ticket');

    // 吊销凭证后已建立的连接被关闭
    const r = await request(s.port, { method: 'POST', path: '/api/auth/logout', headers: auth });
    assert.equal(r.status, 200);
    const c1 = await closedOf(w, 'revoked close');
    assert.equal(c1.code, 4403);
    note(t, 'ws-close-codes', { reuse: c2, notAuth: c3, expired: c5, revoked: c1 });
  });
});

test('WebSocket 拒绝是终态：非法首帧后紧跟合法 auth 和 ping，始终收不到 banners 和 pong', async (t) => {
  await withServer({}, async ({ s }) => {
    const token = await pair(s);
    const out = {};
    for (const [label, batch] of [
      // 同一次 TCP 写入里的三帧
      ['same-write', true],
      // 分三次写入
      ['separate-writes', false],
    ]) {
      const tk = await ticketFor(s, token);
      const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
      const frames = ['not json', JSON.stringify({ type: 'auth', ticket: tk }), JSON.stringify({ type: 'ping', n: 1 })];
      if (batch) w.sendBatch(frames);
      else for (const f of frames) w.conn.send(f);
      const c = await closedOf(w, `${label} close`);
      const entry = wsEntries(s).at(-1);
      // 关闭完成后，服务端要么在鉴权层（dropped）要么在连接层（droppedAfterClose）丢弃了后两帧
      await waitFor(() => entry.droppedAfterClose !== undefined, { what: 'server saw close' });
      const ignored = entry.dropped + entry.droppedAfterClose;
      // 合法 ticket 没被看过：仍可用于新连接，说明第二帧从未进入鉴权逻辑
      const w2 = await wsConnect(s.port, { headers: { Origin: s.origin } });
      w2.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
      await waitFor(() => w2.messages.length >= 1, { what: 'ticket still valid' });
      out[label] = {
        close: { code: c.code, reason: c.reason },
        received: w.messages.length,
        clientDroppedAfterClose: w.conn.droppedAfterClose,
        serverState: entry.state,
        auth: entry.auth,
        ignoredFrames: ignored,
        ignoredByAuthLayer: entry.dropped,
        ignoredByConnectionLayer: entry.droppedAfterClose,
        sendBlocked: entry.sendBlocked ?? 0,
        ticketStillUsable: msgs(w2)[0].type === 'banners',
      };
      w2.conn.close();
      assert.equal(c.code, 4401);
      assert.equal(c.reason, 'bad_first_frame');
      assert.equal(w.messages.length, 0, 'no banners / pong');
      assert.equal(w.conn.droppedAfterClose, 0, 'no data frames on the wire after close either');
      assert.equal(entry.state, 'rejected');
      assert.equal(ignored, 2, 'both following frames ignored');
      assert.equal(entry.sendBlocked ?? 0, 0);
      assert.equal(msgs(w2)[0].type, 'banners');
    }
    note(t, 'ws-reject-terminal', out);
  });
});

// 用缩短的 idleMs（10 秒，比 ticket 的 30 秒短）构造两种情况；规则与 24 小时时相同，只是常数不同。
const IDLE = 10_000;
const whoami = (s, token) => request(s.port, { path: '/api/whoami', headers: { Authorization: `Bearer ${token}` } });

async function authedSocket(s, token) {
  const tk = await ticketFor(s, token);
  const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
  w.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
  await waitFor(() => w.messages.length >= 1, { what: 'banners' });
  assert.equal(msgs(w)[0].type, 'banners');
  return w;
}

test('空闲过期：ticket 尚未过期，但凭证已空闲过期时首帧被拒', async (t) => {
  await withServer({ idleMs: IDLE }, async ({ s, advance }) => {
    const token = await pair(s);
    const tk = await ticketFor(s, token); // 取 ticket 是一次活动；ticket 30 秒后过期
    advance(IDLE + 1); // 凭证空闲 10.001 秒 → 过期；ticket 还剩约 20 秒
    const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
    w.conn.send(JSON.stringify({ type: 'auth', ticket: tk }));
    const c = await closedOf(w, 'idle first-frame close');
    const http = await whoami(s, token);
    const out = { close: { code: c.code, reason: c.reason }, received: w.messages.length, httpAfter: http.status };
    note(t, 'idle-ticket-valid-credential-expired', out);
    assert.equal(c.code, 4401);
    assert.equal(c.reason, 'credential_idle_expired');
    assert.equal(w.messages.length, 0);
    assert.equal(http.status, 401);
  });
});

test('空闲过期：连接建立后，业务帧计为活动；空闲过期后业务帧被拒并关闭连接', async (t) => {
  await withServer({ idleMs: IDLE }, async ({ s, advance }) => {
    const token = await pair(s);
    const w = await authedSocket(s, token); // 首帧鉴权是活动：lastUsed = T
    const out = {};

    // WS 业务帧更新活动时间，HTTP 能看到：T+6 ping，T+12 whoami（距鉴权 12 秒 > 10 秒，但距 ping 6 秒）
    advance(6_000);
    w.conn.send(JSON.stringify({ type: 'ping', n: 1 }));
    await waitFor(() => w.messages.length >= 2, { what: 'pong 1' });
    advance(6_000);
    out.httpAfterWsActivity = (await whoami(s, token)).status;
    assert.equal(out.httpAfterWsActivity, 200);

    // HTTP 活动同样延长 WS：T+18 ping（距 whoami 6 秒）
    advance(6_000);
    w.conn.send(JSON.stringify({ type: 'ping', n: 2 }));
    await waitFor(() => w.messages.length >= 3, { what: 'pong 2' });
    out.pongs = msgs(w).filter((m) => m.type === 'pong').map((m) => m.n);

    // 之后空闲 10.001 秒：业务帧被拒，连接关闭，没有 pong；HTTP 也 401
    advance(IDLE + 1);
    w.conn.send(JSON.stringify({ type: 'ping', n: 3 }));
    const c = await closedOf(w, 'idle close');
    out.close = { code: c.code, reason: c.reason };
    out.pongsAfter = msgs(w).filter((m) => m.type === 'pong').map((m) => m.n);
    out.httpAfterExpiry = (await whoami(s, token)).status;
    note(t, 'idle-after-connect', out);
    assert.deepEqual(out.pongs, [1, 2]);
    // 业务帧触发的过期检查吊销凭证，按吊销关闭该凭证的所有连接（与定期清理相同的关闭码）
    assert.equal(c.code, 4403);
    assert.equal(c.reason, 'revoked:idle');
    assert.deepEqual(out.pongsAfter, [1, 2]);
    assert.equal(out.httpAfterExpiry, 401);
  });
});

test('空闲过期：没有任何帧时，定期清理吊销凭证并关闭连接', async (t) => {
  await withServer({ idleMs: IDLE }, async ({ s, advance }) => {
    const token = await pair(s);
    const w = await authedSocket(s, token);
    advance(IDLE); // 恰好 10 秒：未超过
    assert.equal(s.sweep(), 0);
    advance(1);
    const swept = s.sweep();
    const c = await closedOf(w, 'sweep close');
    const http = (await whoami(s, token)).status;
    note(t, 'idle-sweep', { swept, close: { code: c.code, reason: c.reason }, http });
    assert.equal(swept, 1);
    assert.equal(c.code, 4403);
    assert.equal(c.reason, 'revoked:idle');
    assert.equal(http, 401);
  });
});

test('WebSocket 5 秒首帧超时（可控时钟）', async (t) => {
  await withServer({}, async ({ s, advance }) => {
    const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
    await waitFor(() => s.socketStates().includes('pending'), { what: 'pending socket' });
    advance(4_999);
    const at4999 = s.socketStates();
    assert.deepEqual(at4999, ['pending'], 'not closed before 5000 ms');
    advance(1);
    const at5000 = s.socketStates();
    const c = await closedOf(w, 'timeout close');
    note(t, 'ws-timeout-virtual', { at4999, at5000, close: { code: c.code, reason: c.reason }, received: w.messages.length });
    assert.deepEqual(at5000, ['rejected']);
    assert.equal(c.code, 4401);
    assert.equal(c.reason, 'auth timeout');
    assert.equal(w.messages.length, 0);
  });
});

test('WebSocket 5 秒首帧超时（真实墙钟，只记录时延）', async (t) => {
  // 真实定时器：只断言最终以 4401 关闭；关闭时延受调度影响，记录在证据里，不作硬断言。
  const s = await startAuthServer({ sweepIntervalMs: 0 });
  try {
    const w = await wsConnect(s.port, { headers: { Origin: s.origin } });
    const c = await within(w.closed, 60_000, 'wall-clock timeout close');
    const ms = c.at - w.openedAt;
    note(t, 'ws-timeout-wallclock', { code: c.code, reason: c.reason, ms, configuredMs: 5000, lateByMs: ms - 5000 });
    assert.equal(c.code, 4401);
    assert.equal(c.reason, 'auth timeout');
    assert.equal(w.messages.length, 0);
  } finally {
    await s.close();
  }
});
