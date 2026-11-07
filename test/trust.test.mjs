import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { piFixture, until, providerPath } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { TrustDecisions } from "../packages/server/dist/trust.js";
const reply = { fallback: { segments: [{ type: "text", text: "完成" }] } };
async function resource(cwd) { await mkdir(path.join(cwd, ".pi"), { recursive: true }); await writeFile(path.join(cwd, ".pi/settings.json"), "{}"); }

test("项目信任在拉起前询问，服务端及时推送且记住选择由 pi 持久化", { timeout: 60000 }, async () => {
 const f = await piFixture(reply); await resource(f.cwd); const server = await startServer(f); let connection;
 try {
  const token = await pair(server); connection = await connect(server, token); const initial = await open(server, token, f);
  const sending = control(server, token, initial, { type: "prompt", message: "信任后发送" });
  const prompt = await until(() => connection.messages.find(m => m.type === "project_trust")); assert.equal(path.resolve(prompt.request.cwd), path.resolve(f.cwd));
  assert.deepEqual((await readdir(path.join(f.root, "pane/run"))).filter(f => f.endsWith(".json")), []);
  const confirmed = await request(server, token, "/api/trust/" + prompt.request.id, { requestId: randomUUID(), decision: { trusted: true, remember: true } }); assert.equal(confirmed.code, 200);
  const result = await sending; assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.projectTrusted, true);
  const saved = JSON.parse(await readFile(path.join(f.agentDir, "trust.json"), "utf8")); assert.ok(JSON.stringify(saved).includes("true"));
  const id = result.value.snapshot.ref.id; await until(async () => (await snapshot(server, token, id)).status === "idle");
 } finally { connection?.close(); await server.close(); await f.cleanup(); }
});

test("没有项目资源但保存为 false 时，以 pane-bridge 的实际不信任结果为准", { timeout: 60000 }, async () => {
 const f = await piFixture(reply); await writeFile(path.join(f.agentDir, "trust.json"), JSON.stringify({ [f.cwd]: false })); const server = await startServer(f);
 try { const token = await pair(server); const initial = await open(server, token, f); const result = await control(server, token, initial, { type: "prompt", message: "无资源目录" }); assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.projectTrusted, false); assert.deepEqual(server.trust.list(), []); }
 finally { await server.close(); await f.cleanup(); }
});

test("进程内 resume 到新项目时及时询问信任，回连实例复用并回报实际加载状态", { timeout: 60000 }, async () => {
 const f = await piFixture(reply); const cwd = path.join(f.root, "other"); await resource(cwd); const target = f.sessionPath("other");
 await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "other", cwd, timestamp: new Date().toISOString() }) + "\n");
 await writeFile(path.join(f.agentDir, "trust.json"), JSON.stringify({ [f.cwd]: true }));
 const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url))] }); let connection;
 try {
  const token = await pair(server); connection = await connect(server, token); const initial = await open(server, token, f); const first = await control(server, token, initial, { type: "prompt", message: "初始项目" }); assert.equal(first.code, 200);
  const id = first.value.snapshot.ref.id; await until(async () => (await snapshot(server, token, id)).status === "idle"); const state = await snapshot(server, token, id); connection.subscribe(state);
   const switching = control(server, token, state, { type: "prompt", message: "/pane-test-resume " + target });
  const prompt = await until(() => connection.messages.find(m => m.type === "project_trust")); assert.equal(path.resolve(prompt.request.cwd), path.resolve(cwd));
  await request(server, token, "/api/trust/" + prompt.request.id, { requestId: randomUUID(), decision: { trusted: false, remember: false } });
  const result = await switching; assert.equal(result.code, 200, JSON.stringify(result));
  const after = await until(async () => { const s = await snapshot(server, token, "other"); return s.ref && !s.readonly && s; }); assert.equal(after.projectTrusted, false);
 } finally { connection?.close(); await server.close(); await f.cleanup(); }
});

test("没有浏览器和超时的信任请求返回 undecided，不将其解释为拒绝", { timeout: 5000 }, async () => {
 const store = { trust: async () => ({ resources: true, saved: null }) };
 const noBrowser = new TrustDecisions(store, () => false, () => assert.fail()); assert.equal(await noBrowser.request(process.cwd()), undefined);
 let pending; const decisions = new TrustDecisions(store, () => true, r => { pending = r; }, 20);
 const result = decisions.request(process.cwd()); await until(() => pending, 1000, 1);
 await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(await result, undefined); assert.deepEqual(decisions.list(), []);
});
