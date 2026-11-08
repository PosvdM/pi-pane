import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { acquireInstanceLock } from "pi-hostkit";
import { piFixture, until } from "./fixtures/helpers.mjs";
import { startServer, pair, request } from "./fixtures/client.mjs";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function within(promise, ms = 6500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("网络测试等待超时")), ms); })]); }
  finally { clearTimeout(timer); }
}
function connect(server, ticket) {
  const ws = new WebSocket(server.origin.replace("http:", "ws:") + "/ws", { origin: server.origin, handshakeTimeout: 2000 });
  let finish; const outcome = new Promise(resolve => { finish = resolve; });
  const closed = new Promise(resolve => ws.once("close", resolve));
  ws.on("error", () => finish("rejected"));
  ws.on("unexpected-response", (_, response) => { response.resume(); finish(response.statusCode); ws.terminate(); });
  ws.on("close", () => finish("closed"));
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", ticket })));
  ws.on("message", raw => { if (JSON.parse(raw.toString()).type === "banners") finish("authed"); });
  return { ws, outcome, closed };
}
async function assertReleased(server, home) {
  assert.equal(server.http.listening, false);
  assert.equal(server.clients.size, 0);
  assert.equal(server.wss.clients.size, 0);
  const lock = await acquireInstanceLock("pi-pane", home);
  assert.ok(lock, "健康关闭释放真实实例锁");
  await lock.release();
}

test("关闭等待健康在途工作时拒绝 ticket 与重连，正常释放实例锁", { timeout: 15000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const work = gate(); let connection; let closing;
  try {
    const token = await pair(server);
    const ticket = (await request(server, token, "/api/ws-ticket", {})).value.ticket;
    const accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
    closing = server.close().then(() => undefined, error => error);
    const issued = await request(server, token, "/api/ws-ticket", {});
    connection = connect(server, issued.value.ticket ?? ticket);
    const outcome = await within(connection.outcome);
    work.release(); await accepted;
    const error = await within(closing);
    assert.equal(error, undefined, "健康关闭不能被关闭期间的新 WebSocket 拖成 shutdownTimeout");
    assert.equal(issued.code, 503); assert.equal(issued.value.error, "serverStopping");
    assert.notEqual(outcome, "authed"); await within(connection.closed);
    await assertReleased(server, f.root + "/pane");
  } finally {
    work.release(); connection?.ws.terminate(); await closing; await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
  }
});

for (const phase of ["before-handshake", "after-handshake"]) test(`关闭终结已进入 upgrade 的迟到连接：${phase}`, { timeout: 15000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const work = gate(); const entered = gate(); let deliver; let connection; let closing;
  const upgrade = server.wss.handleUpgrade.bind(server.wss);
  try {
    const token = await pair(server); const ticket = (await request(server, token, "/api/ws-ticket", {})).value.ticket;
    const accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
    server.wss.handleUpgrade = (req, socket, head, callback) => {
      if (phase === "before-handshake") { deliver = () => upgrade(req, socket, head, callback); entered.release(); }
      else upgrade(req, socket, head, ws => { deliver = () => callback(ws); entered.release(); });
    };
    connection = connect(server, ticket); await within(entered.promise);
    closing = server.close().then(() => undefined, error => error);
    deliver(); deliver = undefined;
    const outcome = await within(connection.outcome);
    work.release(); await accepted;
    assert.equal(await within(closing), undefined, "迟到 upgrade 不能妨碍健康关闭");
    assert.notEqual(outcome, "authed"); await within(connection.closed);
    await assertReleased(server, f.root + "/pane");
    assert.equal(server.auth.redeemTicket(ticket), token, "迟到连接不能兑换 ticket");
  } finally {
    work.release(); connection?.ws.terminate(); deliver?.(); await closing; await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
  }
});

test("关闭期间仅保留实例探测，其他 HTTP 入口统一返回 serverStopping", { timeout: 15000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const work = gate(); let closing;
  try {
    const token = await pair(server); const accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
    closing = server.close();
    assert.equal((await request(server, token, "/api/instance")).code, 200);
    for (const [method, route] of [
      ["POST", "/api/auth/pair"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/code"], ["POST", "/api/ws-ticket"],
      ["GET", "/api/sessions"], ["GET", "/api/trust"], ["POST", "/api/trust/test"], ["POST", "/api/sessions/open"],
      ...["snapshot", "history", "control", "query", "ui"].map(operation => [operation === "snapshot" || operation === "history" ? "GET" : "POST", "/api/sessions/test/" + operation]),
      ["POST", "/api/assets"], ["POST", "/api/assets/touch"], ["GET", "/api/assets/sha256-" + "a".repeat(64)],
      ["GET", "/api/blobs/sha256-" + "a".repeat(64)], ["POST", "/bridge/launch"], ["POST", "/bridge/event"], ["GET", "/"],
    ]) {
      const result = await request(server, token, route, method === "POST" ? {} : undefined, method);
      assert.equal(result.code, 503, method + " " + route); assert.equal(result.value.error, "serverStopping");
    }
    work.release(); await accepted; await closing; await assertReleased(server, f.root + "/pane");
  } finally { work.release(); await closing?.catch(() => {}); await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});
