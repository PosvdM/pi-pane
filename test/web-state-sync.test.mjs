import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Sessions } from "../packages/server/dist/sessions.js";
import { SessionModel } from "../packages/server/dist/model.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";

const uiExtension = fileURLToPath(new URL("./fixtures/web-ui.ts", import.meta.url));

test("名称和真实 pi 思考级别刷新快照，并在缓存提交后通知其他订阅者", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  let a, b;
  try {
    const token = await pair(server);
    let result = await control(server, token, await open(server, token, f), { type: "prompt", message: "/pane-web-ready" });
    assert.equal(result.code, 200, JSON.stringify(result)); let state = result.value.snapshot;
    a = await connect(server, token); b = await connect(server, token);
    for (const client of [a, b]) {
      client.subscribe(state); client.ws.send(JSON.stringify({ type: "ping" }));
      await until(() => client.messages.some(m => m.type === "pong"));
    }
    result = await control(server, token, state, { type: "set_session_name", name: "状态同步" });
    assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.state.sessionName, "状态同步");
    assert.equal((await snapshot(server, token, state.ref.id)).state.sessionName, "状态同步");

    const source = server.sessions.records.get(state.ref.id);
    const observed = [];
    const off = source.model.subscribe(source.model.snapshot().cursor, message => {
      if (message.event.type === "pane_status") observed.push({ revision: message.event.controlRevision, state: structuredClone(source.state) });
    });
    const route = "/api/sessions/" + state.ref.id + "/query";
    for (const command of [
      { type: "set_thinking_level", level: "high" },
      { type: "prompt", message: "/pane-web-state thinking low" },
      { type: "prompt", message: "/pane-web-state name 扩展名称" },
    ]) {
      state = await snapshot(server, token, state.ref.id); const before = observed.length;
      result = await control(server, token, state, command); assert.equal(result.code, 200, JSON.stringify(result));
      const key = command.message?.includes(" name ") ? "sessionName" : "thinkingLevel";
      const value = key === "sessionName" ? "扩展名称" : command.level ?? "low";
      const committed = await until(() => observed.slice(before).find(event => event.state[key] === value)).catch(error => {
        throw new Error(JSON.stringify({ command, cached: source.state, observed: observed.slice(before), messages: b.messages.slice(-12) }), { cause: error });
      });
      for (const client of [a, b]) await until(() => client.messages.some(m => m.event?.type === "pane_status" && m.event.controlRevision === committed.revision));
      const queried = await request(server, token, route, { type: "state" });
      assert.equal(queried.code, 200); assert.equal(queried.value[key], value);
      assert.equal((await snapshot(server, token, state.ref.id)).state[key], value);
    }
    off();

    const handle = source.handle; const send = handle.send.bind(handle);
    handle.send = (command, options) => command.type === "get_state" ? Promise.resolve({ success: false, error: "刷新被拒绝" }) : send(command, options);
    result = await control(server, token, await snapshot(server, token, state.ref.id), { type: "set_session_name", name: "已确认名称" });
    assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.status, "accepted");
    handle.send = send;
    const confirmed = await request(server, token, route, { type: "state" }); assert.equal(confirmed.value.sessionName, "已确认名称");
    await until(() => b.messages.some(m => m.event?.type === "pane_diagnostic" && m.event.message.includes("刷新被拒绝")));
  } finally { a?.close(); b?.close(); await server.close(); await f.cleanup(); }
});

function harness() {
  const manager = Object.create(Sessions.prototype); manager.stateRefreshes = new WeakMap(); manager.sync = async () => {};
  const model = new SessionModel({ source: "pane", id: "state-sync" }, { detach: value => structuredClone(value) });
  const state = { sessionName: "原名称", thinkingLevel: "off", model: { id: "old", input: ["text", "image"] } };
  const requests = [];
  const handle = { acceptingInput: true, send: command => new Promise((resolve, reject) => requests.push({ command, resolve, reject })) };
  const session = { model, handle, state, closed: false };
  const events = []; model.subscribe(model.snapshot().cursor, message => events.push(message.event));
  return { manager, session, requests, events };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("状态事件合并刷新，查询期间的事件追加一次查询，缓存提交后才发送新 revision", async () => {
  const { manager, session, requests, events } = harness();
  for (const type of ["model_select", "thinking_level_select", "model_changed", "thinking_level_changed", "session_info_changed"]) manager.receive(session, { type });
  assert.equal(requests.length, 0, "receive 不同步启动或等待查询");
  await tick(); assert.equal(requests.length, 1); assert.equal(requests[0].command.type, "get_state");
  for (let i = 0; i < 10; i++) manager.receive(session, { type: "session_info_changed" });
  const revision = session.model.controlRevision;
  const state = { ...session.state, sessionName: "新名称", thinkingLevel: "high", model: { id: "text-only", input: ["text"] } };
  requests[0].resolve({ success: true, data: state }); await tick();
  assert.deepEqual(session.state, state); assert.equal(session.model.controlRevision, revision + 1);
  assert.equal(session.state.model.input.includes("image"), false);
  assert.equal(events.at(-1).type, "pane_status"); assert.equal(requests.length, 2);
  requests[1].resolve({ success: true, data: structuredClone(state) }); await tick();
  assert.equal(session.model.controlRevision, revision + 1, "值未变化时不额外递增 revision");
});

for (const change of ["epoch", "handle", "model", "acceptingInput", "closed"]) {
  test(`状态刷新丢弃失效的 ${change} 结果`, async () => {
    const { manager, session, requests, events } = harness(); const original = session.state;
    const pending = manager.refreshState(session); await tick(); assert.equal(requests.length, 1);
    if (change === "epoch") session.model.reset([], null);
    else if (change === "handle") session.handle = { ...session.handle };
    else if (change === "model") session.model = new SessionModel({ source: "pane", id: "replacement" }, { detach: value => value });
    else if (change === "acceptingInput") session.handle.acceptingInput = false;
    else session.closed = true;
    const revision = session.model.controlRevision;
    requests[0].resolve({ success: true, data: { ...original, sessionName: "过期名称" } }); await pending;
    assert.equal(session.state, original); assert.equal(session.model.controlRevision, revision);
    assert.equal(events.some(event => event.type === "pane_status"), false);
  });
}

test("新代次的刷新独立于旧查询，旧查询收尾不能清除新任务", async () => {
  for (const change of ["epoch", "handle"]) {
    const { manager, session, requests } = harness();
    const old = manager.refreshState(session); await tick();
    if (change === "epoch") session.model.reset([], null);
    else session.handle = { ...session.handle };
    const current = manager.refreshState(session); await tick(); assert.equal(requests.length, 2);
    requests[0].resolve({ success: true, data: { ...session.state, sessionName: "旧代次" } }); await old;
    assert.equal(session.state.sessionName, "原名称");
    assert.equal(manager.stateRefreshes.get(session).promise, current);
    requests[1].resolve({ success: true, data: { ...session.state, sessionName: "新代次" } }); await current;
    assert.equal(session.state.sessionName, "新代次"); assert.equal(manager.stateRefreshes.has(session), false);
  }
});

test("事件状态刷新失败只产生诊断", async () => {
  for (const rejected of [false, true]) {
    const { manager, session, requests, events } = harness(); const original = session.state;
    manager.receive(session, { type: "session_info_changed" }); await tick();
    if (rejected) requests[0].reject(new Error("传输失败"));
    else requests[0].resolve({ success: false, error: "查询被拒绝" });
    await tick(); assert.equal(session.state, original); assert.equal(session.model.controlRevision, 0);
    assert.equal(events.filter(event => event.type === "pane_diagnostic").length, 1);
    assert.equal(events.some(event => event.type === "pane_status"), false);
  }
});
