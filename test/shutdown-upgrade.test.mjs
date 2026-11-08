import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { acquireInstanceLock } from "pi-hostkit";
import { piFixture, until } from "./fixtures/helpers.mjs";
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
  let closing; let client; let raw; let rawClosed; let released;
  try {
    let accepted;
    if (kind === "stopping") {
      accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
      closing = server.close().then(() => undefined, error => error);
    }
    server.http.once("upgrade", (_, socket) => { raw = socket; rawClosed = new Promise(resolve => socket.once("close", resolve)); });
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
    await within(rawClosed);
    await assertReleased(server, f.root + "/pane");
  } finally {
    work.release(); client?.socket.destroy(); raw?.destroy(); await released?.release();
    await closing; await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
  }
});

for (const kind of ["bad-origin", "bad-path", "stopping"]) {
  for (const mode of ["fallback", "error", "shutdown"]) test(`拒绝 upgrade 的 end 回调缺失时仍收尾：${kind}/${mode}`, { timeout: 15000 }, async () => {
    const f = await piFixture(); const server = await startServer(f); const work = gate();
    let client; let raw; let rawClosed; let closing;
    try {
      const accepted = server.sessions.inflight.run("test.healthy-work", () => work.promise);
      if (kind === "stopping") closing = server.close().then(() => undefined, error => error);
      const entered = gate();
      server.http.prependOnceListener("upgrade", (_, socket) => {
        raw = socket; rawClosed = new Promise(resolve => socket.once("close", resolve));
        const end = socket.end.bind(socket);
        socket.end = (...args) => {
          assert.ok(server.upgrades.has(socket), "拒绝前登记原始 socket");
          assert.ok(socket.listenerCount("error") > 0, "拒绝前补挂错误监听");
          // 真实发送响应和 FIN，仅阻止 end 完成回调，用于验证独立兜底。
          if (typeof args.at(-1) === "function") args.pop();
          entered.release(); return end(...args);
        };
      });
      client = halfOpen(server, kind === "bad-origin" ? { origin: "http://example.invalid" } : kind === "bad-path" ? { route: "/not-ws" } : {});
      await within(entered.promise);
      assert.match(await within(client.ended), new RegExp(`^HTTP/1.1 ${kind === "stopping" ? 503 : 403} `));
      assert.equal(client.socket.writableEnded, false);
      assert.equal(raw.destroyed, false, "end 回调缺失时保持原始 socket，测试不依赖对端关闭");
      if (mode === "error") {
        raw.emit("error", new Error("测试拒绝响应发送故障"));
        assert.equal(raw.destroyed, true, "发送错误直接销毁 socket，不抛出未处理 error");
      } else if (mode === "fallback") {
        await within(rawClosed, 2500);
        assert.equal(raw.destroyed, true, "短兜底独立于 end 完成回调");
        await until(() => server.upgrades.size === 0, 1000);
      }
      if (kind === "stopping" && mode === "shutdown") {
        const terminate = server.terminateConnections.bind(server);
        server.terminateConnections = () => { terminate(); assert.equal(raw.destroyed, true, "网络收尾的第二次终结覆盖关闭期间拒绝的 socket"); };
      }
      closing ??= server.close().then(() => undefined, error => error);
      if (kind !== "stopping" && mode === "shutdown") assert.equal(raw.destroyed, true, "关闭入口同步销毁已拒绝的 socket");
      work.release(); await accepted;
      assert.equal(await within(closing), undefined);
      await within(rawClosed);
      await assertReleased(server, f.root + "/pane");
    } finally {
      work.release(); client?.socket.destroy(); raw?.destroy(); await closing;
      await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
    }
  });
}
