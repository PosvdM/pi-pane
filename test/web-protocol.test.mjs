import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, utimes, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrustDecisions } from "../packages/server/dist/trust.js";
import { ExportStore } from "../packages/server/dist/exports.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";
const uiExtension = fileURLToPath(new URL("./fixtures/web-ui.ts", import.meta.url));
const quick = { fallback: { segments: [{ type: "text", text: "完成" }] } };
async function ready(server, token, f) {
  const result = await control(server, token, await open(server, token, f), { type: "prompt", message: "/pane-web-ready" });
  assert.equal(result.code, 200, JSON.stringify(result)); return result.value.snapshot;
}
async function subscribed(client, state) {
  const count = client.messages.filter(m => m.type === "pong").length;
  client.subscribe(state); client.ws.send(JSON.stringify({ type: "ping" }));
  await until(() => client.messages.filter(m => m.type === "pong").length > count);
}

test("终端专用命令在未托管时拒绝，不启动 pi 或请求模型", { timeout: 30000 }, async () => {
  const f = await piFixture(quick); const server = await startServer(f);
  try {
    const token = await pair(server); const state = await open(server, token, f);
    const names = ["settings", "trust", "tree", "reload", "login", "logout", "import", "bug", "scoped-models",
      "share", "copy", "changelog", "hotkeys", "llama", "mcp", "debug", "arminsayshi", "dementedelves"];
    for (const type of ["prompt", "steer", "follow_up"]) for (const name of names) {
      for (const draft of [undefined, [{ type: "text", text: "/" + name + " 参数" }]]) {
        const result = await control(server, token, state, { type, message: draft ? "不能覆盖草稿" : "/" + name }, draft ? { draft } : {});
        assert.equal(result.code, 400, JSON.stringify(result));
        assert.equal(result.value.error, "unsupportedCommand");
        assert.equal(result.value.message, "pi-pane 不支持 /" + name + "，请在终端中使用 pi");
      }
    }
    const current = await snapshot(server, token, state.ref.id);
    assert.equal(current.hosted, false); assert.equal(current.controlRevision, state.controlRevision);
    assert.equal(server.sessions.records.get(state.ref.id).handle, undefined);
    assert.deepEqual(await readdir(path.join(f.root, "pane/run")), []);
    await assert.rejects(stat(path.join(f.root, "requests.jsonl")), { code: "ENOENT" });
  } finally { await server.close(); await f.cleanup(); }
});

test("delivery 只接受 prompt 的两种取值，拒绝时不启动 pi", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f);
  try {
    const token = await pair(server); const state = await open(server, token, f);
    const types = ["steer", "follow_up", "stop", "close", "restart", "set_model", "set_thinking_level",
      "compact", "new_session", "fork", "clone", "set_session_name", "export"];
    for (const type of types) {
      const result = await control(server, token, state, { type, message: "输入", delivery: "followUp" });
      assert.equal(result.code, 400, JSON.stringify(result)); assert.equal(result.value.error, "invalidCommand");
    }
    for (const delivery of ["follow_up", "", null, 1, true]) {
      const result = await control(server, token, state, { type: "prompt", message: "输入", delivery });
      assert.equal(result.code, 400); assert.equal(result.value.error, "invalidCommand");
    }
    assert.deepEqual(await readdir(path.join(f.root, "pane/run")), []);
    await assert.rejects(stat(path.join(f.root, "requests.jsonl")), { code: "ENOENT" });
  } finally { await server.close(); await f.cleanup(); }
});

test("已托管的同名扩展命令优先于终端限制，提示模板按 delivery 排队", { timeout: 30000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "hang" }] } });
  await mkdir(path.join(f.agentDir, "prompts"));
  await writeFile(path.join(f.agentDir, "prompts", "pane-queue.md"), "模板展开：$ARGUMENTS");
  const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    const token = await pair(server); let state = await ready(server, token, f);
    const route = "/api/sessions/" + state.ref.id + "/query";
    const commands = await request(server, token, route, { type: "commands" });
    assert.ok(commands.value.commands.some(command => command.name === "debug" && command.source === "extension"));
    assert.ok(commands.value.commands.some(command => command.name === "pane-queue" && command.source === "prompt"));
    const records = async () => (await readFile(path.join(f.root, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    let result = await control(server, token, state, { type: "prompt", message: "保持运行" });
    assert.equal(result.code, 200, JSON.stringify(result));
    state = result.value.snapshot;
    await until(async () => (await records()).some(record => record.kind === "hang"));
    const source = server.sessions.records.get(state.ref.id); const calls = []; const responses = [];
    const send = source.handle.send.bind(source.handle);
    source.handle.send = async (command, options) => {
      const response = await send(command, options); calls.push(command); responses.push(response); return response;
    };
    result = await control(server, token, await snapshot(server, token, state.ref.id), { type: "prompt", message: "/debug 扩展已执行", delivery: "followUp" });
    assert.equal(result.code, 200, JSON.stringify(result)); assert.deepEqual(result.value.result, { handled: true });
    assert.equal((await request(server, token, route, { type: "state" })).value.sessionName, "扩展已执行");
    assert.equal(calls.filter(command => command.type === "get_commands").length, 1);
    for (const type of ["prompt", "steer", "follow_up"]) {
      const before = calls.length;
      result = await control(server, token, await snapshot(server, token, state.ref.id), { type, message: "/settings" });
      assert.equal(result.code, 400); assert.equal(result.value.error, "unsupportedCommand");
      assert.deepEqual(calls.slice(before).map(command => command.type), ["get_commands"]);
    }
    result = await control(server, token, await snapshot(server, token, state.ref.id), { type: "prompt", message: "/pane-queue 未指定" });
    assert.equal(result.code, 409); assert.equal(result.value.error, "rpcRejected");
    assert.match(result.value.message, /already processing/);
    const controlRoute = "/api/sessions/" + state.ref.id + "/control";
    for (const delivery of ["followUp", "steer"]) {
      state = await snapshot(server, token, state.ref.id);
      const body = { requestId: randomUUID(), expectedEpoch: state.cursor.epoch, expectedRevision: state.controlRevision,
        command: { type: "prompt", delivery }, draft: [{ type: "text", text: "/pane-queue " + delivery }] };
      result = await request(server, token, controlRoute, body);
      assert.equal(result.code, 200, JSON.stringify(result));
      const index = calls.findLastIndex(command => command.type === "prompt");
      assert.equal(calls[index].streamingBehavior, delivery); assert.equal("delivery" in calls[index], false);
      assert.equal(responses[index].data.disposition, "queued");
      assert.deepEqual((await request(server, token, controlRoute, body)).value, result.value);
      const conflict = await request(server, token, controlRoute, { ...body,
        command: { ...body.command, delivery: delivery === "steer" ? "followUp" : "steer" } });
      assert.equal(conflict.code, 409); assert.equal(conflict.value.error, "idempotencyConflict");
    }
    assert.equal((await request(server, token, route, { type: "state" })).value.pendingMessages, 2);
    assert.equal((await records()).filter(record => record.kind === "request").length, 1);
    const stopped = await control(server, token, await snapshot(server, token, state.ref.id), { type: "stop" });
    assert.equal(stopped.code, 200, JSON.stringify(stopped));
    assert.deepEqual([...stopped.value.clearedText].sort(), ["模板展开：followUp", "模板展开：steer"].sort());
  } finally { await server.close(); await f.cleanup(); }
});

test("HTTP 会话列表、快照与所有查询只返回 pane 类型", { timeout: 30000 }, async () => {
  const f = await piFixture(quick); const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    const token = await pair(server); const file = f.sessionPath("listed");
    const timestamp = new Date().toISOString(); const firstText = "首".repeat(240);
    await writeFile(file, [
      { type: "session", version: 3, id: "listed", cwd: f.cwd, timestamp, parentSession: f.sessionPath("parent") },
      { type: "message", id: "entry", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: firstText }], timestamp: Date.now() } },
    ].map(JSON.stringify).join("\n") + "\n");
    await utimes(file, new Date(0), new Date(0));
    const listed = async () => (await request(server, token, "/api/sessions")).value.sessions.find(row => row.id === "listed");
    let row = await listed(); assert.equal(row.hosted, false); assert.equal("status" in row, false);
    assert.equal(row.sessionFile, file); assert.equal(row.title, firstText.slice(0, 200)); assert.equal(row.parentSessionFile, f.sessionPath("parent"));
    assert.equal(new Date(row.createdAt).toISOString(), row.createdAt); assert.equal(new Date(row.modifiedAt).toISOString(), row.modifiedAt);
    for (const field of ["path", "firstMessage", "allMessagesText", "created", "modified", "parentSessionPath"]) assert.equal(field in row, false);
    let state = await open(server, token, f, { sessionFile: file }); assert.equal(state.hosted, false); assert.equal("state" in state, false);
    row = await listed(); assert.equal(row.status, state.status); assert.equal(row.hosted, false);
    const sent = await control(server, token, state, { type: "prompt", message: "/pane-web-ready" }); assert.equal(sent.code, 200, JSON.stringify(sent));
    state = sent.value.snapshot; assert.equal(state.hosted, true); assert.equal(state.state.sessionId, "listed"); assert.equal(state.state.model.images, true); assert.equal("input" in state.state.model, false);
    row = await listed(); assert.equal(row.hosted, true); assert.equal(row.status, state.status);
    const route = "/api/sessions/" + state.ref.id + "/query";
    const calls = []; const handle = server.sessions.records.get(state.ref.id).handle; const send = handle.send.bind(handle);
    handle.send = (command, options) => { calls.push(command.type); return send(command, options); };
    for (const [type, rpc] of Object.entries({ state: "get_state", models: "get_available_models", commands: "get_commands", stats: "get_session_stats", forkPoints: "get_fork_messages" })) {
      const result = await request(server, token, route, { type }); assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(calls.at(-1), rpc);
      assert.equal("success" in result.value, false); assert.equal("data" in result.value, false); assert.equal("command" in result.value, false);
      if (type === "state") assert.equal(result.value.running, false);
      if (type === "models") assert.ok(result.value.models.every(model => typeof model.images === "boolean" && !("baseUrl" in model)));
      if (type === "commands") assert.ok(result.value.commands.some(command => command.name === "pane-web-ready"));
      if (type === "stats") assert.ok(result.value.messages.user >= 1);
      if (type === "forkPoints") assert.deepEqual(result.value.points, [{ entryId: "entry", text: firstText }]);
      assert.equal((await request(server, token, route, { type: rpc })).value.error, "unsupportedQuery");
    }
    handle.send = async () => ({ success: false, error: "查询被拒绝" });
    const rejected = await request(server, token, route, { type: "state" }); assert.equal(rejected.code, 409); assert.equal(rejected.value.error, "rpcRejected");
    handle.send = send;
    const closed = await control(server, token, await snapshot(server, token, state.ref.id), { type: "close" }); assert.equal(closed.code, 200); assert.equal("stopReport" in closed.value, false);
    assert.equal((await snapshot(server, token, state.ref.id)).hosted, false); assert.equal((await listed()).hosted, false);
  } finally { await server.close(); await f.cleanup(); }
});

test("控制结果只包含 pane outcome，导出下载需要本实例标识与鉴权", { timeout: 30000 }, async () => {
  const f = await piFixture(quick); const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] });
  try {
    const token = await pair(server); let state = await ready(server, token, f);
    const first = await control(server, token, state, { type: "prompt", message: "用于导出的会话" }); assert.equal(first.code, 200);
    state = await until(async () => { const current = await snapshot(server, token, state.ref.id); return current.status === "idle" && current.entries.some(entry => entry.message?.role === "assistant") && current; });
    let result = await control(server, token, state, { type: "prompt", message: "/pane-web-cancel-transitions" });
    assert.deepEqual(result.value.result, { handled: true }); assert.equal("response" in result.value, false); state = result.value.snapshot;
    for (const type of ["new_session", "fork", "clone"]) {
      result = await control(server, token, state, { type, ...(type === "fork" ? { entryId: "unused" } : {}) });
      assert.equal(result.code, 200, JSON.stringify(result)); assert.deepEqual(result.value.result, { cancelled: true }); state = result.value.snapshot;
    }
    const invalid = await control(server, token, state, { type: "export" }, { expectedRevision: -1 }); assert.equal(invalid.code, 409);
    const route = "/api/sessions/" + state.ref.id + "/control";
    const body = { requestId: randomUUID(), expectedEpoch: state.cursor.epoch, expectedRevision: state.controlRevision, command: { type: "export", outputPath: path.join(f.root, "禁止写出.html") } };
    result = await request(server, token, route, body); assert.equal(result.code, 200, JSON.stringify(result));
    const id = result.value.result.exportId; assert.match(id, /^[A-Za-z0-9_-]{22}$/); assert.equal(Buffer.from(id, "base64url").length, 16);
    assert.deepEqual((await request(server, token, route, body)).value, result.value);
    const url = server.origin + "/api/exports/" + id;
    assert.equal((await fetch(url)).status, 401);
    const download = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    assert.equal(download.status, 200); assert.equal(download.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(download.headers.get("content-disposition"), 'attachment; filename="pi-session.html"'); assert.match(await download.text(), /<!DOCTYPE html>/i);
    assert.ok((await stat(path.join(f.root, "pane/tmp/exports", id + ".html"))).isFile());
    await assert.rejects(stat(path.join(f.root, "禁止写出.html")), { code: "ENOENT" });
    for (const invalidId of ["bad", "a".repeat(21), "a".repeat(23), "a".repeat(22), "%2e%2e%2fsecret"]) {
      const response = await request(server, token, "/api/exports/" + invalidId); assert.equal(response.code, 400); assert.equal(response.value.error, "invalidExportId");
    }
    const unregistered = randomBytes(16).toString("base64url");
    await writeFile(path.join(f.root, "pane/tmp/exports", unregistered + ".html"), "禁止下载");
    assert.equal((await request(server, token, "/api/exports/" + unregistered)).code, 404);
    const other = new ExportStore(path.join(f.root, "pane")); await assert.rejects(other.download(id), { code: "exportMissing" });
    await server.sessions.exports.sweep(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    assert.equal((await request(server, token, "/api/exports/" + id)).code, 404);
    await assert.rejects(stat(path.join(f.root, "pane/tmp/exports", id + ".html")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(f.root, "pane/tmp/exports", unregistered + ".html")), { code: "ENOENT" });
  } finally { await server.close(); await f.cleanup(); }
});

test("UI 多标签回答、取消、超时、重订阅与写者退出同步解决消息", { timeout: 30000 }, async () => {
  const f = await piFixture(quick); const server = await startServer(f, { extraExtensions: [providerPath, uiExtension] }); let a, b;
  try {
    const token = await pair(server); let state = await ready(server, token, f);
    a = await connect(server, token); b = await connect(server, token); await subscribed(a, state); await subscribed(b, state);
    const source = server.sessions.records.get(state.ref.id); const handle = source.handle;
    const responses = []; const respond = handle.respondUi.bind(handle); handle.respondUi = response => { responses.push(response); respond(response); };
    const begin = async (kind, timeout) => {
      const before = a.messages.length;
      let outcome;
      const pending = control(server, token, await snapshot(server, token, state.ref.id), { type: "prompt", message: `/pane-web-dialog ${kind}${timeout ? " " + timeout : ""}` }).then(result => { outcome = result; return result; });
      const message = await until(() => a.messages.slice(before).find(m => m.type === "ui_request" && m.request.kind === kind) ?? (outcome?.code !== undefined && outcome));
      assert.equal(message.type, "ui_request", JSON.stringify({ message, state, messages: a.messages.slice(before) }));
      return { pending, dialog: message.request };
    };
    const answer = (dialog, value, extra = {}) => request(server, token, "/api/sessions/" + state.ref.id + "/ui", { requestId: randomUUID(), expectedEpoch: source.model.epoch, id: dialog.id, ...(value === undefined ? {} : { answer: value }), ...extra });
    const resolved = async (dialog, reason) => { for (const client of [a, b]) await until(() => client.messages.some(m => m.type === "ui_resolved" && m.id === dialog.id && m.reason === reason)); };
    let { pending, dialog } = await begin("select", 5000);
    assert.equal("method" in dialog, false); assert.equal("timeout" in dialog, false); assert.ok(Date.parse(dialog.expiresAt) > Date.now());
    const before = b.messages.length; await subscribed(b, await snapshot(server, token, state.ref.id));
    const replay = await until(() => b.messages.slice(before).find(m => m.type === "ui_request" && m.request.id === dialog.id)); assert.deepEqual(replay.request, dialog);
    assert.equal((await answer(dialog, { value: "非法选项" })).code, 400); assert.equal(responses.length, 0); assert.equal(source.ui.size, 1);
    assert.equal((await answer(dialog, { confirmed: true })).value.error, "invalidUiAnswer");
    assert.equal((await answer(dialog, undefined, { response: { value: "甲" } })).value.error, "invalidUiAnswer");
    assert.equal((await answer(dialog, { value: "甲" })).code, 200); await resolved(dialog, "answered");
    assert.deepEqual(responses.at(-1), { id: dialog.id, value: "甲" }); assert.deepEqual((await answer(dialog, { value: "乙" })).value, { status: "alreadyHandled" });
    assert.equal((await pending).code, 200); assert.equal(source.ui.size, 0);
    ({ pending, dialog } = await begin("confirm")); assert.equal((await answer(dialog, { confirmed: false })).code, 200); await resolved(dialog, "answered"); assert.equal((await pending).code, 200);
    ({ pending, dialog } = await begin("editor")); assert.equal((await answer(dialog)).code, 200); await resolved(dialog, "cancelled"); assert.equal((await pending).code, 200);
    ({ pending, dialog } = await begin("input"));
    const revision = (await snapshot(server, token, state.ref.id)).controlRevision;
    const exportPending = control(server, token, await snapshot(server, token, state.ref.id), { type: "export" });
    await until(() => source.control.waiting.length === 1);
    assert.equal(source.model.controlRevision, revision, "导出在普通队列中等待对话框命令结束");
    assert.equal((await answer(dialog)).code, 200); await pending;
    assert.equal((await exportPending).value.error, "rpcRejected", "空会话的导出由 pi 拒绝，队列仍正常执行");
    const sentCount = responses.length;
    ({ pending, dialog } = await begin("input", 200)); await resolved(dialog, "expired"); assert.equal(source.ui.size, 0); assert.equal(responses.length, sentCount);
    assert.equal((await answer(dialog, { value: "过期" })).value.status, "alreadyHandled"); assert.equal((await pending).code, 200);
    const count = b.messages.filter(m => m.type === "ui_request" && m.request.id === dialog.id).length;
    await subscribed(b, await snapshot(server, token, state.ref.id)); assert.equal(b.messages.filter(m => m.type === "ui_request" && m.request.id === dialog.id).length, count);
    const switching = { type: "extension_ui_request", id: "switching-dialog", method: "input", title: "切换时的对话框", timeout: 5000 };
    handle.callbacks.onRecord(switching); await until(() => source.ui.has(switching.id));
    const switched = await control(server, token, await snapshot(server, token, state.ref.id), { type: "new_session" }); assert.equal(switched.code, 200, JSON.stringify(switched));
    await resolved({ id: switching.id }, "closed"); assert.equal(source.ui.size, 0);
    await until(() => source.id !== state.ref.id && source.handle?.acceptingInput);
    state = await snapshot(server, token, source.id); await subscribed(a, state); await subscribed(b, state);
    ({ pending, dialog } = await begin("input")); await handle.stop(); await resolved(dialog, "closed"); assert.equal(source.ui.size, 0); await pending;
  } finally { a?.close(); b?.close(); await server.close(); await f.cleanup(); }
});

test("项目信任回答和到期向全部浏览器广播解决消息", { timeout: 30000 }, async () => {
  const f = await piFixture(); const server = await startServer(f); let a, b;
  try {
    const token = await pair(server); a = await connect(server, token); b = await connect(server, token);
    server.sessions.store.trust = async () => ({ resources: true });
    const pending = server.trust.request(f.cwd); const asked = await until(() => a.messages.find(m => m.type === "project_trust"));
    const response = await request(server, token, "/api/trust/" + asked.request.id, { requestId: randomUUID(), decision: { trusted: false, remember: false } }); assert.equal(response.code, 200); await pending;
    for (const client of [a, b]) await until(() => client.messages.some(m => m.type === "project_trust_resolved" && m.id === asked.request.id));
    server.trust.timeoutMs = 50;
    const expiry = server.trust.request(path.join(f.cwd, "other"));
    const timed = await until(() => a.messages.find(m => m.type === "project_trust" && m.request.id !== asked.request.id)); await expiry;
    for (const client of [a, b]) await until(() => client.messages.some(m => m.type === "project_trust_resolved" && m.id === timed.request.id));
    assert.deepEqual(server.trust.list(), []);
    const events = []; const trust = new TrustDecisions(server.sessions.store, () => true, request => events.push(request), 10, id => events.push(id));
    assert.equal(await trust.request(f.cwd), undefined); assert.equal(events[1], events[0].id);
  } finally { a?.close(); b?.close(); await server.close(); await f.cleanup(); }
});

test("未构建 Web 目录返回提示，静态资源返回对应 MIME", { timeout: 30000 }, async () => {
  const f = await piFixture(); const webRoot = path.join(f.root, "web"); const server = await startServer(f, { webRoot });
  try {
    let response = await fetch(server.origin + "/"); assert.equal(response.status, 404); assert.equal((await response.json()).message, "Web 界面未构建，请运行 npm run build");
    await mkdir(webRoot); await writeFile(path.join(webRoot, "index.html"), "测试首页");
    response = await fetch(server.origin + "/"); assert.equal(response.status, 200); assert.equal(await response.text(), "测试首页");
    for (const [extension, mime] of Object.entries({ svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", webp: "image/webp", woff2: "font/woff2", json: "application/json; charset=utf-8", map: "application/json; charset=utf-8" })) {
      await writeFile(path.join(webRoot, "asset." + extension), "内容"); response = await fetch(server.origin + "/asset." + extension); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), mime);
    }
    assert.equal((await fetch(server.origin + "/missing")).status, 404);
  } finally { await server.close(); await f.cleanup(); }
});
