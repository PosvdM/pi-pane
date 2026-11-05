// pane P0 #11 的浏览器部分：配对、BroadcastChannel、WebSocket 首帧 ticket、退出登录、服务端重启，
// 以及同机其他 127.0.0.1 端口的页面能否调用 pi-pane 接口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAuthServer } from '../lib/auth-server.mjs';
import { startPlainServer } from '../lib/plain-server.mjs';
import { forEachBrowser } from './browser-common.mjs';
import { note, sleep } from './helpers.mjs';

test('pane #11 鉴权（浏览器）', async (t) => {
  await forEachBrowser(t, async (st, open, name) => {
    let s = await startAuthServer();
    const other = await startPlainServer();
    try {
      const b = await open('normal');
      const port = s.port;

      // 1. 配对：地址带 #code，兑换后从地址栏移除，配对码不进服务端日志
      const code = s.newPairCode();
      const A = await b.newTab();
      await A.goto(`${s.origin}/#code=${code}`);
      assert.equal(await A.call('ready'), 'ready');
      const snapA = await A.call('snapshot');
      note(st, 'A-after-pair', { href: snapA.href, hash: snapA.hash, cookie: snapA.cookie, events: snapA.events });
      assert.equal(snapA.hash, '');
      assert.ok(!snapA.href.includes(code));
      assert.equal(snapA.cookie, '');
      assert.ok(!s.log.some((e) => (e.path ?? '').includes(code)), 'code never reaches server log');
      assert.equal((await A.call('whoami')).status, 200);

      // 2. WebSocket 首帧 ticket
      const wsA = await A.call('connectWs');
      note(st, 'A-ws', wsA);
      assert.equal(wsA.first?.type, 'banners');

      // 3. 新标签页经 BroadcastChannel 取得凭证
      const B = await b.newTab();
      await B.goto(`${s.origin}/`);
      assert.equal(await B.call('ready'), 'ready');
      const snapB = await B.call('snapshot');
      note(st, 'B-events', snapB.events);
      assert.ok(snapB.events.includes('got-from-tab'));
      assert.equal((await B.call('whoami')).status, 200);
      assert.equal((await B.call('connectWs')).first?.type, 'banners');

      // 4. 同机其他端口的页面
      const credsBefore = s.credentialCount();
      const logFrom = s.log.length;
      const aEventsBefore = (await A.call('snapshot')).events.length;
      const E = await b.newTab();
      await E.goto(`${other.origin}/evil/`);
      const attack = await E.call('attack', s.origin, s.instanceId);
      await sleep(300);
      const serverSaw = s.log.slice(logFrom).map((e) => ({
        kind: e.kind ?? 'http',
        method: e.method,
        path: e.path,
        origin: e.origin,
        secFetchSite: e.secFetchSite,
        status: e.status,
        reason: e.reason,
      }));
      note(st, 'evil-page-observed', attack);
      note(st, 'evil-server-log', serverSaw);
      const aEventsAfter = (await A.call('snapshot')).events.slice(aEventsBefore);
      note(st, 'A-events-during-attack', aEventsAfter);
      assert.equal(attack.corsGetInstance.ok, false, 'CORS read blocked');
      assert.equal(attack.preflightTicket.ok, false, 'preflight blocked');
      assert.equal(attack.websocket.opened, false, 'ws handshake rejected');
      assert.deepEqual(attack.broadcastChannel.received ?? [], [], 'no credential via BroadcastChannel');
      // 弹出的 pi-pane 窗口（同源）会正常经频道索要凭证；这里只检查跨源页面发出的 nonce=evil 消息没有到达
      assert.ok(!aEventsAfter.some((e) => e.endsWith('/evil')), 'pane tab did not receive the evil BC message');
      assert.ok(!(attack.openerAccess.ok && attack.openerAccess.value?.read), 'cannot read pane sessionStorage');
      // 服务端：跨源请求只得到 403 或不需要鉴权的公开信息；没有签发 ticket 或凭证
      for (const e of serverSaw) {
        if (e.kind === 'ws') assert.equal(e.status, 403);
        else if (e.path === '/api/instance' && e.method === 'GET' && e.origin === undefined) assert.equal(e.status, 200);
        else if (e.path === '/' && e.method === 'GET') continue; // window.open 打开 pi-pane 页面本身
        else if (e.origin === s.origin) continue; // 弹出的 pi-pane 窗口自己的请求
        else assert.equal(e.status, 403, JSON.stringify(e));
      }
      assert.equal(s.credentialCount(), credsBefore);

      // Cookie 不按端口隔离：其他端口设的 Cookie 是否随 pi-pane 的请求发出
      assert.ok(!s.log.some((e) => e.cookie), 'no cookie before other port sets one');
      const evilCookie = await E.call('setCookie');
      const fromCookie = s.log.length;
      const who = await A.call('whoami');
      const paneCookie = s.log.slice(fromCookie).map((e) => e.cookie).filter(Boolean);
      const paneDocCookie = (await A.call('snapshot')).cookie;
      note(st, 'cross-port-cookie', { setOnOtherPort: evilCookie, sentToPane: paneCookie, paneDocumentCookie: paneDocCookie, whoami: who.status });
      assert.equal(who.status, 200);
      await E.close();

      // 5. Host 检查：localhost、模拟 DNS 重绑定的域名
      const H = await b.newTab();
      const hostResults = {};
      for (const h of ['localhost', 'rebind.test']) {
        if (h === 'rebind.test' && (name === 'webkit' || name === 'safari')) {
          hostResults[h] = '未测（无法在该驱动里映射主机名）';
          continue;
        }
        try {
          const r = await H.goto(`http://${h}:${port}/api/instance`);
          hostResults[h] = r.status ?? (await H.text()).slice(0, 80);
        } catch (e) {
          hostResults[h] = `navigation error: ${String(e.message).split('\n')[0]}`;
        }
      }
      note(st, 'host-check', hostResults);
      const hostLog = s.log.filter((e) => e.reason === 'bad_host').map((e) => e.host);
      note(st, 'host-check-server-log', hostLog);
      assert.ok(hostLog.some((h) => h.startsWith('localhost:')), 'localhost request reached server and was rejected');
      if (name === 'chrome' || name === 'edge' || name === 'firefox') {
        assert.ok(hostLog.some((h) => h.startsWith('rebind.test:')), 'rebind.test rejected');
      }
      await H.close();

      // 6. 退出登录：广播 logout，其他标签页清除凭证；服务端关闭 WebSocket
      const logoutStatus = await A.call('logout');
      await sleep(500);
      const snapB2 = await B.call('snapshot');
      note(st, 'logout', { logoutStatus, B: { hasCredential: snapB2.hasCredential, wsClose: snapB2.wsClose, events: snapB2.events } });
      assert.equal(snapB2.hasCredential, false);
      assert.ok(snapB2.wsClose, 'B websocket closed');
      assert.equal((await B.call('whoami')).status, 401);

      // 7. 手动输入配对码重新登录
      await A.call('pairManually', s.newPairCode());
      assert.equal((await A.call('snapshot')).phase, 'ready');

      // 8. 服务端重启（同端口）：旧标签页不把失效凭证交给新标签页；旧标签页收到 401 后回到配对页
      // 除其他端口设的 Cookie 外，浏览器没有带任何 Cookie（服务端从不发 Set-Cookie）
      assert.ok(!s.log.some((e) => e.cookie && e.cookie !== 'p0_other_port=1'), 'no pi-pane cookie');
      await s.close();
      s = await startAuthServer({ port });
      const C = await b.newTab();
      await C.goto(`${s.origin}/`);
      const phaseC = await C.call('ready');
      const snapC = await C.call('snapshot');
      const aWho = await A.call('whoami');
      const snapA2 = await A.call('snapshot');
      note(st, 'restart', { phaseC, eventsC: snapC.events, aWhoami: aWho.status, aPhase: snapA2.phase, aEvents: snapA2.events.slice(-3) });
      assert.equal(phaseC, 'need-pair');
      assert.ok(!snapC.events.includes('got-from-tab'));
      assert.equal(aWho.status, 401);
      assert.equal(snapA2.phase, 'need-pair');
      assert.ok(snapA2.events.includes('cleared:401-instance-changed'));

      assert.ok(!s.log.some((e) => e.cookie && e.cookie !== 'p0_other_port=1'), 'no pi-pane cookie');
    } finally {
      await s.close().catch(() => {});
      await other.close();
    }
  });
});
