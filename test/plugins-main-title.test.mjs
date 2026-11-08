import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { piFixture, until, providerPath } from "./fixtures/helpers.mjs";
import { startServer, pair, request, open, control, snapshot } from "./fixtures/client.mjs";
import { Sessions } from "../packages/server/dist/sessions.js";

const script = { fallback: { segments: [{ type: "text", text: "名称测试完成" }] } };

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

test("真实主会话改名、清空及重启只读打开同步更新插件上下文和树", { timeout: 60000 }, async () => {
  const f = await piFixture(script); const extension = path.join(f.root, "clear-name.mjs");
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
    const started = await control(server, token, current, { type: "prompt", message: "名称测试" }); assert.equal(started.code, 200);
    current = await until(async () => { const value = await snapshot(server, token, "named"); return value.status === "idle" && value.inFlight.phase === "idle" && value; });
    assert.equal(server.sessions.records.get("named").state.sessionName, "名称 A");
    const tree = await server.mainTree.snapshot({ openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    const events = []; off = server.mainTree.subscribe({ epoch: tree.epoch, revision: tree.revision }, change => events.push(change));
    const renamed = await control(server, token, current, { type: "set_session_name", name: "名称 B" });
    assert.equal(renamed.code, 200); assert.equal(renamed.value.status, "accepted");
    assert.equal(api.get("named").title, "名称 B"); assert.equal(api.list().find(info => info.ref.id === "named").title, "名称 B");
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.title === "名称 B"));
    const refreshed = await request(server, token, "/api/tree/snapshot", { openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    assert.equal(refreshed.value.nodes.find(node => node.id === "pane:session:named").title, "名称 B");
    current = await snapshot(server, token, "named");
    const cleared = await control(server, token, current, { type: "prompt", message: "/pane-test-clear-name" }); assert.equal(cleared.code, 200);
    assert.equal(api.get("named").title, "名称测试");
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.title === "名称测试"));
    current = await snapshot(server, token, "named");
    assert.equal((await control(server, token, current, { type: "close" })).value.status, "done");
    const metadata = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "session_info");
    assert.equal(metadata.at(-1).name, "", "真实 pi 将显式清空持久化为空字符串");
    off(); off = undefined; await server.close();
    server = await startServer(f, { extraExtensions: [providerPath, extension] }); token = await pair(server);
    current = await open(server, token, f, { sessionFile: file }); api = server.sessions.mainSessions("test-plugin");
    assert.equal(current.readonly, true); assert.equal(server.sessions.records.get("named").handle, undefined);
    assert.equal(api.get("named").title, "名称测试");
    const reopened = await server.mainTree.snapshot({ openNodeIds: ["pane:session:named"], recentSince: new Date(0).toISOString() });
    assert.equal(reopened.nodes.find(node => node.id === "pane:session:named").title, "名称测试");
    off = server.mainTree.subscribe({ epoch: reopened.epoch, revision: reopened.revision }, change => events.push(change));
    const cachedState = server.sessions.records.get("named").state;
    const parentId = server.sessions.records.get("named").model.entries.at(-1)?.id ?? null;
    await appendFile(file, JSON.stringify({ type: "session_info", id: "external-name", parentId, name: "只读名称 C", timestamp: new Date().toISOString() }) + "\n");
    await until(() => api.get("named").title === "只读名称 C");
    assert.strictEqual(server.sessions.records.get("named").state, cachedState);
    await until(() => events.some(change => change.type === "upsert" && change.node.id === "pane:session:named" && change.node.title === "只读名称 C"));
  } finally { off?.(); await server.close(); await f.cleanup(); }
});
