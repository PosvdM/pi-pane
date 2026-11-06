// 同机另一个 127.0.0.1 端口上的页面，尝试调用 pi-pane 接口（pane P0 #11）。
// 每项尝试返回页面能观察到的结果；服务端是否执行由测试对照服务端日志判断。

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: `${e?.name}: ${e?.message}` };
  }
}

function wsTry(url) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return resolve({ constructed: false, error: String(e) });
    }
    const out = { constructed: true, opened: false, messages: [] };
    ws.onopen = () => {
      out.opened = true;
      ws.send(JSON.stringify({ type: 'auth', ticket: 'guess' }));
    };
    ws.onmessage = (e) => out.messages.push(String(e.data));
    ws.onclose = (e) => resolve({ ...out, closeCode: e.code });
    setTimeout(() => resolve({ ...out, timeout: true }), 3000);
  });
}

function bcTry(instanceId) {
  return new Promise((resolve) => {
    if (!('BroadcastChannel' in globalThis)) return resolve({ supported: false });
    const ch = new BroadcastChannel('pi-pane-auth');
    const got = [];
    ch.onmessage = (e) => got.push(e.data);
    ch.postMessage({ type: 'request', nonce: 'evil', instanceId });
    // 负向观察窗口：1 秒内没有回应。测试另用 pi-pane 标签页的事件日志和正向对照确认这条消息没有跨源送达。
    setTimeout(() => {
      ch.close();
      resolve({ supported: true, received: got, windowMs: 1000 });
    }, 1000);
  });
}

window.__f = {
  ready: async () => 'evil-ready',
  // 设计不用 Cookie 的依据：Cookie 不按端口隔离。这里在其他端口设一个 Cookie，观察它是否随 pi-pane 的请求发出。
  setCookie: async () => {
    document.cookie = 'p0_other_port=1; path=/; SameSite=Lax';
    return document.cookie;
  },
  async attack(target, instanceId) {
    const r = {};
    // 1. 读取不需要鉴权的接口（CORS 模式）
    r.corsGetInstance = await attempt(async () => (await fetch(`${target}/api/instance`)).status);
    // 2. no-cors GET：请求能发出，但响应不可读
    r.noCorsGetInstance = await attempt(async () => {
      const res = await fetch(`${target}/api/instance`, { mode: 'no-cors' });
      return { type: res.type, status: res.status };
    });
    // 3. 简单请求 POST 猜配对码（text/plain，不触发预检）
    r.simplePostPair = await attempt(async () => {
      const res = await fetch(`${target}/api/auth/pair`, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ code: '00000000000000000000' }),
      });
      return { type: res.type, status: res.status };
    });
    // 4. 带 Authorization 的请求（触发预检）
    r.preflightTicket = await attempt(async () =>
      (await fetch(`${target}/api/ws-ticket`, { method: 'POST', headers: { Authorization: 'Bearer guess' } })).status,
    );
    // 5. WebSocket
    r.websocket = await wsTry(`${target.replace('http:', 'ws:')}/ws`);
    // 6. 同名 BroadcastChannel 索要凭证
    r.broadcastChannel = await bcTry(instanceId);
    // 7. 读 pi-pane 窗口的 sessionStorage
    r.openerAccess = await attempt(async () => {
      const w = window.open(`${target}/`, '_blank');
      if (!w) return 'popup-blocked';
      // 弹出窗口先是与本页同源的 about:blank；条件等待它导航到 pi-pane（跨源后读 location 会抛错），截止 10 秒。
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          void w.location.href;
        } catch {
          break;
        }
        if (Date.now() > deadline) throw new Error('popup did not navigate to pi-pane');
        await new Promise((res) => setTimeout(res, 20));
      }
      try {
        return { read: w.sessionStorage.getItem('pi-pane.auth') };
      } finally {
        w.close();
      }
    });
    // 8. 本源的 sessionStorage / cookie 里没有 pi-pane 的东西
    r.ownStorage = { sessionStorage: sessionStorage.length, cookie: document.cookie };
    return r;
  },
};
