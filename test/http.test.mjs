import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { piFixture, until } from "./fixtures/helpers.mjs";
import { startServer, pair, request } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";
async function raw(server, headers, pathname = "/api/instance") {
 return new Promise((resolve, reject) => { const req = http.request(server.origin + pathname, { headers }, response => { let body = ""; response.on("data", c => body += c); response.on("end", () => resolve({ code: response.statusCode, headers: response.headers, body })); }); req.on("error", reject); req.end(); });
}
test("HTTP Host/Origin、无 Cookie 和响应安全头，WebSocket 首帧一次性与吊销", { timeout: 60000 }, async () => {
 const f = await piFixture(); const server = await startServer(f); const clients = [];
 try {
  const port = new URL(server.origin).port;
  for (const host of ["localhost:" + port, "evil.test:" + port, "127.0.0.1", "[::1]:" + port, "127.0.0.1:" + (Number(port) + 1)]) assert.equal((await raw(server, { Host: host })).code, 403);
  for (const origin of ["http://localhost:" + port, "http://127.0.0.1:" + (Number(port) + 1), "null", server.origin + "/"]) assert.equal((await raw(server, { Origin: origin })).code, 403);
  const good = await raw(server, { Origin: server.origin }); assert.equal(good.code, 200);
  assert.equal(good.headers["cache-control"], "no-store"); assert.equal(good.headers["x-content-type-options"], "nosniff"); assert.equal(good.headers["referrer-policy"], "no-referrer"); assert.equal(good.headers["set-cookie"], undefined); assert.equal(good.headers["access-control-allow-origin"], undefined);
  const token = await pair(server); assert.equal((await raw(server, { Cookie: "credential=" + token }, "/api/sessions")).code, 401);
  const first = await connect(server, token); clients.push(first); assert.equal(first.messages[0].type, "banners"); assert.equal(first.messages[0].paneProtocol, 1);
  const ticket = (await request(server, token, "/api/ws-ticket", {})).value.ticket;
  const second = await connect(server, token, { ticket }); clients.push(second);
  const replay = await connect(server, token, { ticket }); clients.push(replay); assert.equal(replay.closed.code, 4401); assert.equal(replay.messages.length, 0);
  const valid = (await request(server, token, "/api/ws-ticket", {})).value.ticket;
  const rejected = await connect(server, token, { ticket: valid, firstFrame: { type: "ping" } }); clients.push(rejected); assert.equal(rejected.closed.code, 4401); assert.equal(rejected.messages.length, 0);
  const usable = await connect(server, token, { ticket: valid }); clients.push(usable); assert.equal(usable.messages[0].type, "banners");
  const incompatible = await connect(server, token, { firstFrame: { type: "auth", ticket: (await request(server, token, "/api/ws-ticket", {})).value.ticket, paneProtocol: [2, 2] } }); clients.push(incompatible); assert.equal(incompatible.closed.code, 4401);
  for (const paneProtocol of [[], [2], [1, 1, 1], null, "1,1", [1.5, 2], [0, 1]]) {
    const ticket = (await request(server, token, "/api/ws-ticket", {})).value.ticket;
    const invalid = await connect(server, token, { firstFrame: { type: "auth", ticket, paneProtocol } }); clients.push(invalid);
    assert.equal(invalid.closed.code, 4401, JSON.stringify(paneProtocol)); assert.equal(invalid.messages.length, 0);
  }
  const highest = await connect(server, token, { firstFrame: { type: "auth", ticket: (await request(server, token, "/api/ws-ticket", {})).value.ticket, paneProtocol: [1, 9] } }); clients.push(highest);
  assert.equal(highest.messages[0].paneProtocol, 1);
  await request(server, token, "/api/auth/logout", {}); await until(() => first.closed && second.closed && usable.closed);
  assert.equal(first.closed.code, 4403); assert.equal((await request(server, token, "/api/sessions")).code, 401);
 } finally { for (const client of clients) client.close(); await server.close(); await f.cleanup(); }
});
