import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { acquireInstanceLock } from "pi-hostkit";
import { piFixture } from "./fixtures/helpers.mjs";
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
    assert.equal(outcome, 503, "新 upgrade 在握手之前返回 HTTP 503"); await within(connection.closed);
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

for (const kind of ["pair", "upload"]) test(`关闭前进入的 ${kind} 请求在读完请求体后复查门禁`, { timeout: 15000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); const work = gate(); const entered = gate(); let closing; let req;
  try {
    const token = await pair(server); const code = server.auth.issuePairCode(); let uploads = 0;
    server.assets.upload = () => { uploads++; throw new Error("关闭后不能上传"); };
    const accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
    const body = kind === "pair" ? JSON.stringify({ code }) :
      '--boundary\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n' +
      '--boundary\r\nContent-Disposition: form-data; name="thumb"; filename="thumb.png"\r\nContent-Type: image/png\r\n\r\nthumb\r\n--boundary--\r\n';
    server.http.once("request", incoming => incoming.once("data", () => entered.release()));
    const response = new Promise((resolve, reject) => {
      req = http.request(server.origin + (kind === "pair" ? "/api/auth/pair" : "/api/assets"), {
        method: "POST", headers: { Authorization: "Bearer " + token, "X-Request-Id": "shutdown-upload", "Content-Type": kind === "pair" ? "application/json" : "multipart/form-data; boundary=boundary" },
      }, res => { const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ code: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) })); });
      req.on("error", reject); req.write(body.slice(0, -1));
    });
    await within(entered.promise); closing = server.close(); req.end(body.slice(-1));
    const result = await within(response);
    assert.equal(result.code, 503); assert.equal(result.value.error, "serverStopping"); assert.equal(uploads, 0);
    if (kind === "pair") assert.ok(server.auth.pair(code).credential, "迟到请求未消费配对码");
    work.release(); await accepted; await closing; await assertReleased(server, f.root + "/pane");
  } finally { work.release(); req?.destroy(); await closing?.catch(() => {}); await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
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
      ["GET", "/api/assets/sha256-" + "a".repeat(64) + "/thumb"], ["GET", "/api/blobs/sha256-" + "a".repeat(64)],
      ["GET", "/api/blobs/sha256-" + "a".repeat(64) + "/thumb"], ["POST", "/bridge/launch"], ["POST", "/bridge/event"],
      ["GET", "/api/plugins"], ["GET", "/api/forms"], ["GET", "/api/banners/removable"], ["POST", "/api/banners/remove"],
      ["POST", "/api/tree/snapshot"], ["GET", "/api/tree/children"], ["POST", "/api/presence/test"],
      ["GET", "/api/plugins/test/catalog"], ["POST", "/api/plugins/test/disable"], ["POST", "/api/plugins/test/tree/snapshot"],
      ["GET", "/api/plugins/test/tree/children"], ["GET", "/api/plugins/test/panels/test"], ["GET", "/api/plugins/test/forms"],
      ["POST", "/api/plugins/test/forms/test"], ["POST", "/api/plugins/test/actions/test/form"], ["POST", "/api/plugins/test/actions/test/invoke"],
      ...["snapshot", "history", "send", "abort"].map(operation => [operation === "snapshot" || operation === "history" ? "GET" : "POST", "/api/plugins/test/sessions/test/" + operation]),
      ["GET", "/"], ["GET", "/unknown"], ["PUT", "/api/sessions/open"],
    ]) {
      const result = await request(server, token, route, method === "POST" ? {} : undefined, method);
      assert.equal(result.code, 503, method + " " + route); assert.equal(result.value.error, "serverStopping");
    }
    work.release(); await accepted; await closing; await assertReleased(server, f.root + "/pane");
  } finally { work.release(); await closing?.catch(() => {}); await server.close().catch(() => {}); await server.lock.release(); await f.cleanup(); }
});
