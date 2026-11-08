import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { FORBIDDEN_PORTS, isForbiddenPort, listenAvoidingForbidden } from "../packages/server/dist/ports.js";
import { PaneError } from "../packages/server/dist/errors.js";
import { piFixture } from "./fixtures/helpers.mjs";
import { startServer } from "./fixtures/client.mjs";

const denied = (code) => (error) => error instanceof PaneError && error.code === code;

function listener(ports) {
  const server = new EventEmitter();
  const events = []; let active = false; let index = 0;
  server.listen = (port, host, callback) => {
    assert.equal(active, false);
    events.push(["listen", port, host]); active = true;
    queueMicrotask(callback); return server;
  };
  server.address = () => ({ port: ports[Math.min(index, ports.length - 1)] });
  server.close = (callback) => {
    assert.equal(active, true); events.push(["close"]);
    queueMicrotask(() => { active = false; index++; callback(); }); return server;
  };
  return { server, events, active: () => active };
}

test("Fetch 禁止端口覆盖首尾、连续区间和普通端口", () => {
  assert.equal(FORBIDDEN_PORTS.size, 83);
  for (const port of [0, 1, 7, 22, 53, 4190, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]) {
    assert.equal(isForbiddenPort(port), true, String(port));
  }
  for (const port of [80, 443, 4319, 5999, 6001, 6664, 6670, 8080, 10079, 10081, 65535]) {
    assert.equal(isForbiddenPort(port), false, String(port));
  }
});

test("自动分配遇到禁止端口时等待关闭后重新监听", async () => {
  const fake = listener([6000, 6667, 4319]);
  assert.equal(await listenAvoidingForbidden(fake.server, "127.0.0.1", 0), 4319);
  assert.deepEqual(fake.events, [
    ["listen", 0, "127.0.0.1"], ["close"], ["listen", 0, "127.0.0.1"], ["close"], ["listen", 0, "127.0.0.1"],
  ]);
  assert.equal(fake.active(), true);
  assert.equal(fake.server.listenerCount("error"), 0);
});

test("自动分配耗尽 20 次尝试后拒绝且没有残留监听", async () => {
  const fake = listener([6000]);
  await assert.rejects(listenAvoidingForbidden(fake.server, "127.0.0.1", 0), denied("forbiddenPort"));
  assert.equal(fake.events.filter(([kind]) => kind === "listen").length, 20);
  assert.equal(fake.events.filter(([kind]) => kind === "close").length, 20);
  assert.equal(fake.active(), false);
  assert.equal(fake.server.listenerCount("error"), 0);
});

test("显式端口只监听一次，普通监听错误不重试且移除错误监听器", async () => {
  const safe = listener([4319]);
  assert.equal(await listenAvoidingForbidden(safe.server, "127.0.0.1", 4319), 4319);
  assert.deepEqual(safe.events, [["listen", 4319, "127.0.0.1"]]);
  for (const synchronous of [false, true]) {
    const fake = listener([4319]); const failure = new Error("监听失败"); let calls = 0;
    fake.server.listen = () => {
      calls++;
      if (synchronous) throw failure;
      queueMicrotask(() => fake.server.emit("error", failure)); return fake.server;
    };
    await assert.rejects(listenAvoidingForbidden(fake.server, "127.0.0.1", 0), error => error === failure);
    assert.equal(calls, 1);
    assert.equal(fake.server.listenerCount("error"), 0);
  }
});

test("配置拒绝与自动分配耗尽后，同一数据目录仍可启动", { timeout: 60000 }, async (t) => {
  const fixture = await piFixture(); let server;
  try {
    await assert.rejects(startServer(fixture, { port: 6000 }), error => {
      assert.equal(denied("forbiddenPort")(error), true);
      assert.match(error.message, /浏览器.*6000.*更换端口/); return true;
    });
    for (const port of [-1, 65536, 1.5, NaN, Infinity, "4319", null]) {
      await assert.rejects(startServer(fixture, { port }), denied("invalidPort"));
    }
    server = await startServer(fixture);
    assert.equal(isForbiddenPort(Number(new URL(server.origin).port)), false);
    assert.equal((await fetch(server.origin + "/api/instance")).status, 200);
    await server.close(); server = undefined;

    const address = t.mock.method(http.Server.prototype, "address", () => ({ port: 6000 }));
    try {
      await assert.rejects(startServer(fixture), denied("forbiddenPort"));
      assert.equal(address.mock.callCount(), 20);
    } finally { address.mock.restore(); }
    server = await startServer(fixture);
    assert.equal((await fetch(server.origin + "/api/instance")).status, 200);
  } finally {
    try { await server?.close(); } finally { await fixture.cleanup(); }
  }
});
