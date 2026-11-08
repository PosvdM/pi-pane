import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { piFixture, until, providerPath } from "./fixtures/helpers.mjs";
import { startServer, pair, request, open, control, snapshot } from "./fixtures/client.mjs";
import { Sessions } from "../packages/server/dist/sessions.js";
import { fallbackSessionTitle, normalizeSessionName, sessionTitle } from "../packages/server/dist/session-title.js";

const script = { fallback: { segments: [{ type: "text", text: "名称测试完成" }] } };

test("共享标题格式器允许主树使用id回退，也允许Web预览保留空值", () => {
  assert.equal(normalizeSessionName("  名称  "), "名称");
  assert.equal(sessionTitle(" 名称 ", "预览", "id"), "名称");
  assert.equal(fallbackSessionTitle("", "id"), "id"); assert.equal(fallbackSessionTitle("", ""), "");
  assert.equal(fallbackSessionTitle("😀".repeat(201), ""), "😀".repeat(200));
});

test("清空名称后的回退标题按完整字符截取，不拆开 Unicode 代理对", () => {
  const session = { id: "fallback", model: { entries: [{ type: "message", message: { role: "user", content: "😀".repeat(201) } }] } };
  assert.equal(Sessions.prototype.fallbackTitle(session), "😀".repeat(200));
});

test("名称刷新不替换普通 RPC 状态对象", () => {
  const state = { sessionName: "旧的状态快照", model: { id: "model" } }; const session = { state };
  Sessions.prototype.setName(session, "较新的名称"); assert.strictEqual(session.state, state); assert.equal(session.name.value, "较新的名称");
  Sessions.prototype.readName(session, [{ type: "session_info", name: "只读元数据名称" }]);
  assert.strictEqual(session.state, state); assert.equal(session.name.value, "只读元数据名称");
});

test("在线事件、重绑定与磁盘名称入口统一归一化空白和清空值", () => {
  for (const [raw, expected] of [[undefined, undefined], ["", undefined], [" \t\n ", undefined], ["  名称  ", "名称"]]) {
    const session = {};
    Sessions.prototype.setName(session, raw); assert.equal(session.name.value, expected);
    Sessions.prototype.readName(session, [{ type: "session_info", name: raw }]); assert.equal(session.name.value, expected);
  }
});

test("目录、只读记录与树共用标题规则，保留真实占位字面量并覆盖无文本与文本块", { timeout: 60000 }, async () => {
  const f = await piFixture(); const server = await startServer(f);
  try {
    const token = await pair(server);
    const cases = [
      { id: "empty", messages: [], expected: "empty" },
      { id: "assistant-only", messages: [{ role: "assistant", content: "助手正文" }], expected: "assistant-only" },
      { id: "assistant-placeholder", messages: [{ role: "assistant", content: "(no messages)" }], expected: "assistant-placeholder" },
      { id: "user-placeholder", messages: [{ role: "user", content: "(no messages)" }], expected: "(no messages)" },
      { id: "text-blocks", messages: [{ role: "user", content: [{ type: "text", text: "一" }, { type: "text", text: "二" }] }], expected: "一 二" },
      { id: "empty-then-text", messages: [{ role: "user", content: [] }, { role: "user", content: "后续文本" }], expected: "后续文本" },
      { id: "blank-then-text", messages: [{ role: "user", content: " \n " }, { role: "user", content: "后续文本" }], expected: "blank-then-text" },
      { id: "long-unicode", messages: [{ role: "user", content: "😀".repeat(201) }], expected: "😀".repeat(200) },
      { id: "explicit", name: "  目录名称  ", messages: [{ role: "user", content: "预览文本" }], expected: "目录名称" },
    ];
    for (const item of cases) {
      const file = f.sessionPath(item.id); const timestamp = new Date().toISOString();
      const entries = [{ type: "session", version: 3, id: item.id, cwd: f.cwd, timestamp }];
      let parentId = null;
      for (let i = 0; i < item.messages.length; i++) { const id = item.id + "-" + i; entries.push({ type: "message", id, parentId, timestamp, message: { ...item.messages[i], timestamp: Date.now() } }); parentId = id; }
      entries.push({ type: "session_info", id: item.id + "-name", parentId, timestamp, name: item.name ?? "" });
      await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    }
    const api = server.sessions.mainSessions("test-plugin"); const openNodeIds = cases.map(item => "pane:session:" + item.id);
    const before = await server.mainTree.snapshot({ openNodeIds, recentSince: new Date(0).toISOString() });
    assert.equal(server.sessions.records.size, 0);
    for (const item of cases) {
      assert.equal(api.get(item.id).title, item.expected, item.id + "：未打开的插件目录");
      assert.equal(before.nodes.find(node => node.id === "pane:session:" + item.id).title, item.expected, item.id + "：目录树");
      assert.equal((await open(server, token, f, { sessionFile: f.sessionPath(item.id) })).readonly, true);
      assert.equal(api.get(item.id).title, item.expected, item.id + "：只读打开后");
    }
    const after = await server.mainTree.snapshot({ openNodeIds, recentSince: new Date(0).toISOString() });
    for (const item of cases) assert.equal(after.nodes.find(node => node.id === "pane:session:" + item.id).title, item.expected, item.id + "：打开后的树");
  } finally { await server.close(); await f.cleanup(); }
});

test("真实主会话改名、清空及重启只读打开同步更新插件上下文和树", { timeout: 60000 }, async () => {
  const f = await piFixture(script); const extension = path.join(f.root, "clear-name.mjs");
  const message = "😀".repeat(201); const expectedTitle = "😀".repeat(200);
  await writeFile(extension, "export default function(pi){pi.registerCommand('pane-test-clear-name',{description:'清空测试名称',handler:async()=>{pi.setSessionName('')}})}");
  let server = await startServer(f, { extraExtensions: [providerPath, extension] }); let off;
  try {
    let token = await pair(server); const file = f.sessionPath("named"); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      { type: "session", version: 3, id: "named", cwd: f.cwd, timestamp: new Date(0).toISOString() },
      { type: "session_info", id: "name-a", parentId: null, name: "名称 A", timestamp: new Date(0).toISOString() },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    await utimes(file, new Date(0), new Date(0));
    let current = await open(server, token, f, { sessionFile: file });
    let api = server.sessions.mainSessions("test-plugin"); assert.equal(api.get("named").title, "名称 A");
    const tree = await server.mainTree.snapshot({ openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    const events = []; off = server.mainTree.subscribe({ epoch: tree.epoch, revision: tree.revision }, change => events.push(change));
    assert.equal(tree.nodes.find(node => node.id === "pane:session:named").messageCount, 0);
    const started = await control(server, token, current, { type: "prompt", message }); assert.equal(started.code, 200);
    current = await until(async () => { const value = await snapshot(server, token, "named"); return value.status === "idle" && value.inFlight.phase === "idle" && value; });
    assert.equal(server.sessions.records.get("named").state.sessionName, "名称 A");
    await server.sessions.sync(server.sessions.records.get("named"));
    const messageCount = server.sessions.mainSessionDetails("named").messageCount; assert.ok(messageCount >= 2);
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.messageCount === messageCount));
    const renamed = await control(server, token, current, { type: "set_session_name", name: "名称 B" });
    assert.equal(renamed.code, 200); assert.equal(renamed.value.status, "accepted");
    assert.equal(api.get("named").title, "名称 B"); assert.equal(api.list().find(info => info.ref.id === "named").title, "名称 B");
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.title === "名称 B"));
    const refreshed = await request(server, token, "/api/tree/snapshot", { openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    assert.equal(refreshed.value.nodes.find(node => node.id === "pane:session:named").title, "名称 B");
    current = await snapshot(server, token, "named");
    const cleared = await control(server, token, current, { type: "prompt", message: "/pane-test-clear-name" }); assert.equal(cleared.code, 200);
    assert.equal(api.get("named").title, expectedTitle);
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.title === expectedTitle));
    current = await snapshot(server, token, "named");
    assert.equal((await control(server, token, current, { type: "close" })).value.status, "done");
    const metadata = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "session_info");
    assert.equal(metadata.at(-1).name, "", "真实 pi 将显式清空持久化为空字符串");
    off(); off = undefined; await server.close();
    server = await startServer(f, { extraExtensions: [providerPath, extension] }); token = await pair(server);
    api = server.sessions.mainSessions("test-plugin");
    const directory = await server.mainTree.snapshot({ openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    assert.equal(server.sessions.records.has("named"), false);
    assert.equal(api.get("named").title, expectedTitle);
    assert.equal(directory.nodes.find(node => node.id === "pane:session:named").title, expectedTitle);
    current = await open(server, token, f, { sessionFile: file });
    assert.equal(current.readonly, true); assert.equal(server.sessions.records.get("named").handle, undefined);
    assert.equal(api.get("named").title, expectedTitle);
    const reopened = await server.mainTree.snapshot({ openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    assert.equal(reopened.nodes.find(node => node.id === "pane:session:named").title, expectedTitle);
    off = server.mainTree.subscribe({ epoch: reopened.epoch, revision: reopened.revision }, change => events.push(change));
    const cachedState = server.sessions.records.get("named").state;
    const parentId = server.sessions.records.get("named").model.entries.at(-1)?.id ?? null;
    await appendFile(file, JSON.stringify({ type: "session_info", id: "external-name", parentId, name: "只读名称 C", timestamp: new Date().toISOString() }) + "\n");
    await until(() => api.get("named").title === "只读名称 C");
    assert.strictEqual(server.sessions.records.get("named").state, cachedState);
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.title === "只读名称 C"));
  } finally { off?.(); await server.close(); await f.cleanup(); }
});
