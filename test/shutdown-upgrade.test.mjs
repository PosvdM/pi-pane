import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { acquireInstanceLock } from "pi-hostkit";
import { piFixture } from "./fixtures/helpers.mjs";
import { startServer } from "./fixtures/client.mjs";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function within(promise, ms = 6500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("upgrade 测试等待超时")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function connections(server) {
  return new Promise((resolve, reject) => server.http.getConnections((error, count) => error ? reject(error) : resolve(count)));
}
function halfOpen(server, { route = "/ws", origin = server.origin, key = "dGhlIHNhbXBsZSBub25jZQ==" } = {}) {
  const url = new URL(server.origin);
  const socket = net.connect({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
  let response = "";
  const ended = new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", chunk => { response += chunk.toString(); });
    socket.once("end", () => resolve(response));
  });
  socket.once("connect", () => socket.write(`GET ${route} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`));
  return { socket, ended };
}
async function assertReleased(server, home) {
  assert.equal(server.http.listening, false);
  assert.equal(await connections(server), 0);
  assert.equal(server.upgrades.size, 0);
  assert.equal(server.clients.size, 0);
  assert.equal(server.wss.clients.size, 0);
  const lock = await acquireInstanceLock("pi-pane", home);
  assert.ok(lock, "健康关闭释放真实实例锁");
  await lock.release();
}

for (const kind of ["bad-origin", "bad-path", "stopping", "bad-key"]) test(`被拒绝的半开 upgrade 不妨碍健康关闭：${kind}`, { timeout: 15000 }, async t => {
  const f = await piFixture(); const server = await startServer(f); const work = gate();
  let closing; let client; let raw; let released;
  try {
    let accepted;
    if (kind === "stopping") {
      accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
      closing = server.close().then(() => undefined, error => error);
    }
    server.http.once("upgrade", (_, socket) => { raw = socket; });
    client = halfOpen(server, kind === "bad-origin" ? { origin: "http://example.invalid" } : kind === "bad-path" ? { route: "/not-ws" } : kind === "bad-key" ? { key: "invalid" } : {});
    const response = await within(client.ended);
    assert.match(response, new RegExp(`^HTTP/1.1 ${kind === "stopping" ? 503 : kind === "bad-key" ? 400 : 403} `));
    assert.equal(client.socket.writableEnded, false, "收到 FIN 后客户端仍保持写侧打开");
    const before = await connections(server);
    closing ??= server.close().then(() => undefined, error => error);
    work.release(); await accepted;
    const error = await within(closing);
    const after = await connections(server);
    released = await acquireInstanceLock("pi-pane", f.root + "/pane");
    t.diagnostic(JSON.stringify({ kind, connectionsBeforeClose: before, connectionsAfterClose: after,
      rawDestroyed: raw.destroyed, closeError: error && { code: error.code, message: error.message, detail: error.detail }, instanceLockReacquired: !!released }));
    await released?.release(); released = undefined;
    assert.equal(error, undefined, "被拒绝的 upgrade 不能把健康关闭拖成网络 shutdownTimeout");
    assert.equal(raw.destroyed, true, "服务端销毁被拒绝的原始 socket，不依赖客户端 FIN");
    await assertReleased(server, f.root + "/pane");
  } finally {
    work.release(); client?.socket.destroy(); raw?.destroy(); await released?.release();
    await closing; await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
  }
});
