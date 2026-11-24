import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { piFixture, until } from "./fixtures/helpers.mjs";
import { startServer, pair, request, open, control } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";

const plugin = fileURLToPath(new URL("./fixtures/pane-plugin/", import.meta.url));
const api = "/api/plugins/sample/";
function caller(client) { return client.messages[0].connectionId; }
function invoke(server, token, client, action, extra = {}) {
  return request(server, token, api + "actions/" + encodeURIComponent(action) + "/invoke", { connectionId: caller(client), idempotencyKey: randomUUID(), ...extra });
}

test("插件通过已鉴权 HTTP 和 WS 提供树、只读流、面板、动作与持久表单", { timeout: 60000 }, async () => {
  const f = await piFixture(); const server = await startServer(f, { plugins: [plugin], pluginTimeoutMs: 1000 }); const clients = [];
  try {
    const token = await pair(server); const first = await connect(server, token); const second = await connect(server, token); clients.push(first, second);
    assert.equal((await request(server, "invalid", "/api/plugins")).code, 401);
    assert.equal((await request(server, token, "/api/plugins")).value.plugins[0].state, "active");
    assert.equal(first.messages[0].banners.length, 2);
    await until(() => first.messages.some((message) => message.type === "form"));
    const tree = (await request(server, token, api + "tree/snapshot", { openNodeIds: [], recentSince: "2026-01-01T00:00:00.000Z" })).value;
    assert.equal(tree.source, "sample"); assert.ok(tree.nodes.some((node) => node.sessionRef?.id === "child"));
    const reset = await request(server, token, api + "tree/children?parentId=sample%3Agroup%3Aroot&epoch=old&limit=1");
    assert.equal(reset.value.reset, true);
    const children = await request(server, token, api + "tree/children?parentId=sample%3Agroup%3Aroot&epoch=" + tree.epoch + "&limit=1");
    assert.equal(children.value.nodes.length, 1);
    const snapshot = (await request(server, token, api + "sessions/child/snapshot")).value;
    assert.equal(snapshot.readonly, true); assert.deepEqual(snapshot.ref, { source: "sample", id: "child" });
    first.ws.send(JSON.stringify({ type: "treeSubscribe", source: "sample", after: { epoch: tree.epoch, revision: tree.revision } }));
    first.subscribe(snapshot);
    await invoke(server, token, first, "sample.emit");
    await until(() => first.messages.some((message) => message.type === "tree") && first.messages.some((message) => message.type === "session"));
    assert.equal(first.messages.find((message) => message.type === "tree").source, "sample");
    const catalog = (await request(server, token, api + "catalog")).value;
    assert.ok(catalog.actions.some((action) => action.id === "sample.form"));
    assert.ok(["markdown", "keyValue"].includes((await request(server, token, api + "panels/sample.panel")).value.type));
    const resolved = (await request(server, token, api + "actions/sample.form/form", { target: { type: "global" } })).value.form;
    assert.equal(resolved.source, "sample");
    assert.equal((await request(server, token, "/api/forms")).value.forms.length, 1);
    const echo = await invoke(server, token, first, "sample.echo", { input: { answers: [], fields: { message: "浏览器输入" } } });
    assert.equal(echo.value.status, "ok");
    const form = (await request(server, token, "/api/forms")).value.forms[0];
    const outcomes = await Promise.all([first, second].map((client) => request(server, token, api + "forms/" + form.id, { connectionId: caller(client), revision: form.revision, outcome: { status: "submitted", values: { answers: [] } }, idempotencyKey: randomUUID() })));
    assert.deepEqual(outcomes.map((result) => result.value.status).sort(), ["accepted", "alreadyHandled"]);
    await until(() => clients.every((client) => client.messages.some((message) => message.type === "formRemoved" && message.source === "sample" && message.formId === form.id)));
    assert.equal((await request(server, token, "/api/forms")).value.forms.length, 0);
    first.ws.send(JSON.stringify({ type: "treeUnsubscribe", source: "sample" }));
    first.ws.send(JSON.stringify({ type: "unsubscribe", ref: snapshot.ref }));
  } finally { for (const client of clients) client.close(); await server.close(); await f.cleanup(); }
});

test("插件超时和异常不影响主会话，迟到结果按原 key 查询", { timeout: 60000 }, async () => {
  const f = await piFixture({ turns: [{ segments: [{ type: "text", text: "运行正常" }] }] }); const server = await startServer(f, { plugins: [plugin], pluginTimeoutMs: 1000 }); let client;
  try {
    const token = await pair(server); client = await connect(server, token);
    const idempotencyKey = randomUUID();
    const pending = await invoke(server, token, client, "sample.slow", { idempotencyKey });
    assert.equal(pending.value.status, "pending");
    const duplicated = await invoke(server, token, client, "sample.slow", { idempotencyKey }); assert.equal(duplicated.value.status, "pending");
    await until(() => server.plugins.runtime.get("sample").inspection().invocations["sample.slow"] === 1);
    let completed;
    await until(async () => { completed = await invoke(server, token, client, "sample.slow", { idempotencyKey }); return completed.value.status === "ok"; });
    assert.equal(completed.value.status, "ok");
    const conflict = await invoke(server, token, client, "sample.echo", { idempotencyKey }); assert.equal(conflict.value.status, "idempotencyConflict");
    const failed = await invoke(server, token, client, "sample.throw"); assert.equal(failed.value.status, "failed");
    const trustReplies = [];
    client.ws.on("message", (raw) => { const message = JSON.parse(raw.toString()); if (message.type === "project_trust") trustReplies.push(request(server, token, "/api/trust/" + message.request.id, { requestId: randomUUID(), decision: { trusted: false, remember: false } }).catch(error => ({ error }))); });
    const session = await open(server, token, f);
    const result = await control(server, token, session, { type: "prompt", message: "插件异常后的主会话" }); assert.equal(result.code, 200); assert.equal(result.value.status, "accepted", JSON.stringify({ result, trust: server.trust.list() }));
    assert.ok((await Promise.all(trustReplies)).every(reply => reply.code === 200));
    assert.equal(server.plugins.runtime.get("sample").inspection().invocations["sample.slow"], 1);
  } finally { client?.close(); await server.close(); await f.cleanup(); }
});

test("请求来源绑定凭证和连接，用户在场确认只路由发起标签页并关闭提示", { timeout: 60000 }, async () => {
  const f = await piFixture(); const server = await startServer(f, { plugins: [plugin], pluginTimeoutMs: 1000 }); const clients = [];
  try {
    const token = await pair(server); const foreign = await pair(server);
    const first = await connect(server, token); const second = await connect(server, token); clients.push(first, second);
    const mismatched = await invoke(server, foreign, first, "sample.echo"); assert.notEqual(mismatched.code, 200);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" }); const key = spki.toString("base64url");
    const deviceId = createHash("sha256").update(spki).digest("base64url");
    const device = { deviceId, publicKey: key, alg: "ECDSA-P256-SHA256", label: "测试设备", connected: true };
    first.ws.send(JSON.stringify({ type: "device", device }));
    const idempotencyKey = randomUUID();
    const pending = await invoke(server, token, first, "sample.presence", { idempotencyKey }); assert.equal(pending.value.status, "pending");
    await until(() => first.messages.some((message) => message.type === "presence"));
    assert.equal(second.messages.some((message) => message.type === "presence"), false);
    const challenge = first.messages.find((message) => message.type === "presence").request;
    const proof = { deviceId, publicKey: key, alg: "ECDSA-P256-SHA256", signature: Buffer.alloc(64, 1).toString("base64url") };
    await request(server, token, "/api/presence/" + challenge.id, { connectionId: caller(second), response: { proof } });
    assert.equal((await invoke(server, token, first, "sample.presence", { idempotencyKey })).value.status, "pending");
    first.ws.send(JSON.stringify({ type: "presenceResponse", id: challenge.id, response: { proof } }));
    let done;
    await until(async () => { done = await invoke(server, token, first, "sample.presence", { idempotencyKey }); return done.value.status === "ok"; });
    assert.equal(done.value.status, "ok");
  } finally { for (const client of clients) client.close(); await server.close(); await f.cleanup(); }
});

test("真实用户在场确认超时不成为最终失败，同键可再次确认并完成", { timeout: 60000 }, async () => {
  const f = await piFixture(); const server = await startServer(f, { plugins: [plugin], pluginTimeoutMs: 1000 }); let client;
  try {
    const token = await pair(server); client = await connect(server, token);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); const spki = publicKey.export({ type: "spki", format: "der" });
    const device = { deviceId: createHash("sha256").update(spki).digest("base64url"), publicKey: spki.toString("base64url"), alg: "ECDSA-P256-SHA256", label: "超时重试设备", connected: true };
    client.ws.send(JSON.stringify({ type: "device", device }));
    const idempotencyKey = randomUUID(); const input = { answers: [], fields: { timeoutMs: "500" } };
    assert.equal((await invoke(server, token, client, "sample.presence", { idempotencyKey, input })).value.status, "pending");
    await until(() => client.messages.some(message => message.type === "presenceClosed" && message.reason === "timeout"));
    const first = client.messages.find(message => message.type === "presence").request.id;
    assert.equal((await invoke(server, token, client, "sample.presence", { idempotencyKey, input })).value.status, "pending");
    await until(() => client.messages.some(message => message.type === "presence" && message.request.id !== first));
    const second = client.messages.filter(message => message.type === "presence").at(-1).request.id;
    client.ws.send(JSON.stringify({ type: "presenceResponse", id: second, response: { proof: { deviceId: device.deviceId, publicKey: device.publicKey, alg: device.alg, signature: Buffer.alloc(64, 2).toString("base64url") } } }));
    await until(async () => (await invoke(server, token, client, "sample.presence", { idempotencyKey, input })).value.status === "ok");
    assert.equal(server.plugins.runtime.get("sample").inspection().invocations["sample.presence"], 2);
  } finally { client?.close(); await server.close(); await f.cleanup(); }
});

test("浏览器重连与插件 tree reset 对齐持久表单，并发登录合并 pending 查询", { timeout: 60000 }, async () => {
  const f = await piFixture(); const server = await startServer(f, { plugins: [plugin], pluginTimeoutMs: 1000 }); const clients = [];
  try {
    const token = await pair(server); const sample = server.plugins.runtime.get("sample");
    assert.equal(server.plugins.operations.pending().length, 1); sample.forms.pending = async () => [];
    const first = await connect(server, token); clients.push(first);
    await until(() => server.plugins.operations.pending().length === 0);
    assert.equal(first.messages.some(message => message.type === "form"), false);
    let treeEmit; sample.tree.subscribe = (_after, emit) => { treeEmit = emit; return () => {}; };
    first.ws.send(JSON.stringify({ type: "treeSubscribe", source: "sample", after: { epoch: "old", revision: 0 } }));
    await until(() => treeEmit);
    const form = { id: "reconnected", source: "sample", revision: 1, title: "重连后的提问", createdAt: "2026-01-02T00:00:00.000Z" };
    sample.forms.pending = async () => [form]; treeEmit({ type: "reset", epoch: "new-backend" });
    await until(() => first.messages.some(message => message.type === "form" && message.form.id === form.id));
    assert.equal(server.plugins.operations.pending()[0].id, form.id);
    let finish; let calls = 0; const gate = new Promise(resolve => { finish = resolve; });
    sample.forms.pending = () => { calls++; return gate; };
    const others = await Promise.all([connect(server, token), connect(server, token)]); clients.push(...others);
    await until(() => calls === 1); finish([]);
    await until(() => others.every(client => client.messages.some(message => message.type === "formRemoved" && message.source === "sample" && message.formId === form.id)));
    assert.equal(calls, 1); assert.equal(server.plugins.operations.pending().length, 0);
    sample.forms.pending = async () => { throw new Error("表单对齐异常"); };
    const failed = await connect(server, token); clients.push(failed); failed.ws.send(JSON.stringify({ type: "ping" }));
    await until(() => failed.messages.some(message => message.type === "pong")); assert.equal(failed.closed, undefined);
  } finally { for (const client of clients) client.close(); await server.close(); await f.cleanup(); }
});

test("插件同步订阅异常只显示插件错误，不关闭共享 WebSocket 或主会话订阅", { timeout: 60000 }, async () => {
  const f = await piFixture(); const server = await startServer(f, { plugins: [plugin], pluginTimeoutMs: 1000 }); let client;
  try {
    const token = await pair(server); client = await connect(server, token); const main = await open(server, token, f); client.subscribe(main);
    const sample = server.plugins.runtime.get("sample");
    sample.sessions.subscribe = () => { throw new Error("会话订阅异常"); };
    sample.tree.subscribe = () => { throw new Error("树订阅异常"); };
    client.ws.send(JSON.stringify({ type: "subscribe", ref: { source: "sample", id: "child" }, after: { epoch: "e", seq: 0 } }));
    await until(() => client.closed || client.messages.some(message => message.type === "notification" && message.notification.source === "sample"));
    assert.equal(client.closed, undefined, "插件异常不能关闭承载主会话的共享连接");
    client.ws.send(JSON.stringify({ type: "treeSubscribe", source: "sample", after: { epoch: "e", revision: 0 } }));
    await until(() => client.messages.filter(message => message.type === "notification" && message.notification.source === "sample").length === 2);
    assert.equal(client.closed, undefined);
    server.sessions.records.get(main.ref.id).model.emit({ type: "pane_status", status: "idle", phase: "idle", detail: "主会话仍可推送" });
    await until(() => client.messages.some(message => message.type === "session" && message.ref.source === "pane" && message.event.detail === "主会话仍可推送"));
  } finally { client?.close(); await server.close(); await f.cleanup(); }
});

test("persistent 横幅跨停用和重启保留，只有配置移除后可二次确认删除并审计", { timeout: 60000 }, async () => {
  const f = await piFixture(); let server; const clients = [];
  try {
    server = await startServer(f, { plugins: [plugin] }); let token = await pair(server); let client = await connect(server, token); clients.push(client);
    const disabled = await request(server, token, api + "disable", { connectionId: caller(client) }); assert.equal(disabled.code, 200);
    const remaining = server.plugins.banners.list(); assert.equal(remaining.length, 1); assert.equal(remaining[0].sourceUnavailable, true);
    assert.equal((await request(server, token, "/api/banners/removable")).value.banners.length, 0);
    assert.notEqual((await request(server, token, "/api/banners/remove", { source: "sample", id: "persistent", connectionId: caller(client), confirmed: true })).code, 200);
    await server.close(); server = await startServer(f, { plugins: [] }); token = await pair(server); client = await connect(server, token); clients.push(client);
    assert.equal(client.messages[0].banners.length, 1); assert.equal(client.messages[0].banners[0].sourceUnavailable, true);
    assert.equal((await request(server, token, "/api/banners/removable")).value.banners.length, 1);
    assert.notEqual((await request(server, token, "/api/banners/remove", { source: "sample", id: "persistent", connectionId: caller(client), confirmed: false })).code, 200);
    assert.equal((await request(server, token, "/api/banners/remove", { source: "sample", id: "persistent", connectionId: caller(client), confirmed: true })).code, 200);
    assert.equal(server.plugins.banners.list().length, 0);
    const audit = (await readFile(f.root + "/pane/plugin-audit.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(audit.length, 1); assert.equal(audit[0].connectionId, caller(client)); assert.equal(audit[0].banner.id, "persistent");
  } finally { for (const client of clients) client.close(); await server?.close(); await f.cleanup(); }
});
