import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { piFixture, until, delay } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";

const script = { fallback: { segments: [{ type: "text", text: "插件保活测试完成" }] } };
async function idle(server, token, id) {
  return until(async () => {
    const current = await snapshot(server, token, id);
    return current.status === "idle" && current.inFlight.phase === "idle" && current;
  }, 20000);
}
async function send(server, token, current, command) {
  const result = await control(server, token, current, command);
  assert.equal(result.code, 200, JSON.stringify(result));
  assert.equal(result.value.status, "accepted", JSON.stringify(result));
  assert.notEqual(result.value.response?.success, false, JSON.stringify(result));
  assert.ok(result.value.snapshot);
  return result.value.snapshot;
}
async function historyFile(server, fixture, id) {
  const directory = await server.sessions.store.sessionDir(fixture.cwd);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `history-${id}.jsonl`);
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id,
    cwd: fixture.cwd, timestamp: new Date(0).toISOString() }) + "\n");
  await utimes(file, new Date(0), new Date(0));
  return file;
}

test("插件主会话适配区分历史与托管，未打开的 hold 在启动后生效且全部释放才回收", { timeout: 60000 }, async (t) => {
  const fixture = await piFixture(script);
  const server = await startServer(fixture, { idleReclaimMs: 5 });
  try {
    const token = await pair(server);
    await open(server, token, fixture);
    const api = server.sessions.mainSessions("test-plugin");
    const otherApi = server.sessions.mainSessions("another-plugin");
    const id = "plugin-history";
    const file = await historyFile(server, fixture, id);
    assert.equal(api.get(id), undefined);
    assert.deepEqual(api.list(), []);
    const failures = t.mock.method(console, "error", () => {});
    const offBad = api.onChange(() => { throw new Error("插件监听器失败"); });
    const observations = [];
    const off = api.onChange(() => observations.push({
      info: api.get(id), holds: server.sessions.records.has(id) ? server.sessions.snapshot(id).holds : [],
    }));
    const releaseFirst = api.hold({ source: "pane", id }, "等待插件结果");
    const releaseSecond = otherApi.hold({ source: "pane", id }, "保留插件上下文");
    assert.equal(server.sessions.records.has(id), false);
    assert.deepEqual(api.list(), []);
    assert.equal(observations.length, 2);
    assert.equal(failures.mock.callCount(), 2);
    await server.sessions.list();
    const historical = api.get(id);
    assert.equal(historical.hosted, false);
    assert.equal(historical.status, "idle");
    assert.equal(historical.sessionFile, file);
    assert.ok(server.sessions.mainSessionCatalog().some((info) => info.ref.id === id));
    assert.deepEqual(api.list(), []);

    const opened = await open(server, token, fixture, { sessionFile: file });
    assert.equal(opened.ref.id, id);
    assert.equal(opened.readonly, true);
    assert.deepEqual(opened.holds, [
      { source: "test-plugin", reason: "等待插件结果" },
      { source: "another-plugin", reason: "保留插件上下文" },
    ]);
    assert.equal(api.get(id).hosted, false);
    assert.deepEqual(api.list(), []);
    assert.equal(server.sessions.records.get(id).handle, undefined);
    const sent = await send(server, token, opened, { type: "prompt", message: "验证预登记保活" });
    assert.equal(sent.ref.id, id);
    await idle(server, token, id);
    assert.deepEqual(api.list().map((info) => info.ref.id), [id]);
    assert.equal(api.get(id).hosted, true);
    assert.ok(observations.some(({ info }) => info?.hosted));
    assert.ok(observations.some(({ info }) => info?.status === "running"));
    assert.ok(observations.some(({ info }) => info?.hosted && info.status === "idle"));
    await delay(10);
    await server.sessions.reclaim();
    assert.equal(api.get(id).hosted, true);
    releaseFirst();
    assert.deepEqual((await snapshot(server, token, id)).holds, [{ source: "another-plugin", reason: "保留插件上下文" }]);
    await delay(10);
    await server.sessions.reclaim();
    assert.equal(api.get(id).hosted, true);
    releaseSecond();
    assert.deepEqual((await snapshot(server, token, id)).holds, []);
    await delay(10);
    await server.sessions.reclaim();
    assert.equal(api.get(id).hosted, false);
    assert.deepEqual(api.list(), []);
    assert.equal((await snapshot(server, token, id)).readonly, true);
    assert.ok(observations.at(-1).info && !observations.at(-1).info.hosted);
    offBad(); off();
    const count = observations.length;
    const release = api.hold({ source: "pane", id }, "取消订阅之后");
    release(); releaseFirst(); releaseSecond();
    assert.equal(observations.length, count);
    assert.throws(() => api.hold({ source: "external", id }, "无效来源"), { code: "invalidHold" });
  } finally { await server.close(); await fixture.cleanup(); }
});

test("插件 hold 的关闭确认清空保活，旧 release 不影响随后登记的 hold", { timeout: 60000 }, async () => {
  const fixture = await piFixture(script);
  const server = await startServer(fixture);
  try {
    const token = await pair(server);
    const api = server.sessions.mainSessions("test-plugin");
    const sent = await send(server, token, await open(server, token, fixture),
      { type: "prompt", message: "等待关闭确认" });
    const id = sent.ref.id;
    await idle(server, token, id);
    const releaseFirst = api.hold({ source: "pane", id }, "插件任务一");
    const releaseSecond = api.hold({ source: "pane", id }, "插件任务二");
    const held = await snapshot(server, token, id);
    const refused = await control(server, token, held, { type: "close" });
    assert.equal(refused.code, 409, JSON.stringify(refused));
    assert.equal(refused.value.error, "holdsConfirmation");
    assert.equal(api.get(id).hosted, true);
    assert.equal((await snapshot(server, token, id)).holds.length, 2);
    const closed = await control(server, token, await snapshot(server, token, id), { type: "close", confirmHolds: true });
    assert.equal(closed.code, 200, JSON.stringify(closed));
    assert.equal(closed.value.status, "done");
    assert.equal(api.get(id).hosted, false);
    assert.deepEqual((await snapshot(server, token, id)).holds, []);
    let changes = 0;
    const off = api.onChange(() => { changes++; });
    const releaseFresh = api.hold({ source: "pane", id }, "关闭后登记");
    assert.equal(changes, 1);
    releaseFirst(); releaseSecond(); releaseFirst();
    assert.equal(changes, 1);
    assert.deepEqual((await snapshot(server, token, id)).holds,
      [{ source: "test-plugin", reason: "关闭后登记" }]);
    releaseFresh(); releaseFresh();
    assert.equal(changes, 2);
    assert.deepEqual((await snapshot(server, token, id)).holds, []);
    assert.deepEqual(api.list(), []);
    off();
  } finally { await server.close(); await fixture.cleanup(); }
});

test("主会话 new/rebind 保活留在原 id，新会话可在原 hold 仍存在时回收", { timeout: 60000 }, async () => {
  const fixture = await piFixture(script);
  const server = await startServer(fixture, { idleReclaimMs: 5 });
  try {
    const token = await pair(server);
    const api = server.sessions.mainSessions("test-plugin");
    const sent = await send(server, token, await open(server, token, fixture),
      { type: "prompt", message: "原会话" });
    const oldId = sent.ref.id;
    await idle(server, token, oldId);
    const releaseOld = api.hold({ source: "pane", id: oldId }, "只保活原会话");
    const before = await snapshot(server, token, oldId);
    await send(server, token, before, { type: "new_session" });
    const currentInfo = await until(() => api.list().find((info) => info.ref.id !== oldId));
    const newId = currentInfo.ref.id;
    assert.notEqual(newId, oldId);
    const current = await idle(server, token, newId);
    assert.notEqual(current.cursor.epoch, before.cursor.epoch);
    assert.deepEqual(current.holds, []);
    assert.equal(current.readonly, false);
    const previous = await snapshot(server, token, oldId);
    assert.equal(previous.readonly, true);
    assert.deepEqual(previous.holds, [{ source: "test-plugin", reason: "只保活原会话" }]);
    assert.equal(api.get(oldId).hosted, false);
    assert.equal(api.get(newId).hosted, true);
    await delay(10);
    await server.sessions.reclaim();
    assert.equal(api.get(newId).hosted, false);
    assert.equal((await snapshot(server, token, oldId)).holds.length, 1);
    const releaseNew = api.hold({ source: "pane", id: newId }, "新会话保活");
    releaseOld();
    assert.deepEqual((await snapshot(server, token, oldId)).holds, []);
    assert.deepEqual((await snapshot(server, token, newId)).holds,
      [{ source: "test-plugin", reason: "新会话保活" }]);
    releaseNew();
  } finally { await server.close(); await fixture.cleanup(); }
});
