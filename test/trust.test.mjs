import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { probeSessionWriterLock, isSameProcess } from "pi-hostkit";
import { piFixture, until, providerPath, delay } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot, request } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { TrustDecisions } from "../packages/server/dist/trust.js";
const reply = { fallback: { segments: [{ type: "text", text: "完成" }] } };
async function resource(cwd) { await mkdir(path.join(cwd, ".pi"), { recursive: true }); await writeFile(path.join(cwd, ".pi/settings.json"), "{}"); }

test("项目信任在拉起前询问，服务端及时推送且记住选择由 pi 持久化", { timeout: 60000 }, async () => {
 const f = await piFixture(reply); await resource(f.cwd); const server = await startServer(f); let connection;
 try {
  const token = await pair(server); connection = await connect(server, token); const initial = await open(server, token, f);
  const requestId = randomUUID();
  const body = { requestId, expectedEpoch: initial.cursor.epoch, expectedRevision: initial.controlRevision, command: { type: "prompt", message: "信任后发送" } };
  const route = "/api/sessions/" + initial.ref.id + "/control";
  const sending = request(server, token, route, body);
  const prompt = await until(() => connection.messages.find(m => m.type === "project_trust")); assert.equal(path.resolve(prompt.request.cwd), path.resolve(f.cwd));
  assert.deepEqual((await readdir(path.join(f.root, "pane/run"))).filter(f => f.endsWith(".json")), []);
  assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
  const confirmed = await request(server, token, "/api/trust/" + prompt.request.id, { requestId: randomUUID(), decision: { trusted: true, remember: true } }); assert.equal(confirmed.code, 200);
  const result = await sending; assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.projectTrusted, true);
  assert.deepEqual((await request(server, token, route, body)).value, result.value);
  const conflict = await request(server, token, route, { ...body, command: { type: "prompt", message: "不同内容" } }); assert.equal(conflict.value.error, "idempotencyConflict");
  const saved = JSON.parse(await readFile(path.join(f.agentDir, "trust.json"), "utf8")); assert.ok(JSON.stringify(saved).includes("true"));
  const id = result.value.snapshot.ref.id; await until(async () => (await snapshot(server, token, id)).status === "idle");
  assert.equal((await readFile(f.env.FAKE_REQUEST_LOG, "utf8")).split("\n").filter(line => line && JSON.parse(line).kind === "request").length, 1);
 } finally { connection?.close(); await server.close(); await f.cleanup(); }
});

test("没有项目资源但保存为 false 时，以 pane-bridge 的实际不信任结果为准", { timeout: 60000 }, async () => {
 const f = await piFixture(reply); await writeFile(path.join(f.agentDir, "trust.json"), JSON.stringify({ [f.cwd]: false })); const server = await startServer(f);
 try { const token = await pair(server); const initial = await open(server, token, f); const result = await control(server, token, initial, { type: "prompt", message: "无资源目录" }); assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.snapshot.projectTrusted, false); assert.deepEqual(server.trust.list(), []); }
 finally { await server.close(); await f.cleanup(); }
});

test("resume 信任回答晚于 RPC 等待期限时，requestId 保持 pending 并追踪最终结果", { timeout: 60000 }, async () => {
 const f = await piFixture(reply); const cwd = path.join(f.root, "other"); await resource(cwd); const target = f.sessionPath("other");
 await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "other", cwd, timestamp: new Date().toISOString() }) + "\n");
 await writeFile(path.join(f.agentDir, "trust.json"), JSON.stringify({ [f.cwd]: true }));
 // 将原 30 秒等待缩短为 5 秒，信任期限仍为默认 55 秒。
 const server = await startServer(f, { rpcTimeoutMs: 5000, extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url))] }); let connection;
 try {
  const token = await pair(server); connection = await connect(server, token); const initial = await open(server, token, f); const first = await control(server, token, initial, { type: "prompt", message: "初始项目" }); assert.equal(first.code, 200);
  const id = first.value.snapshot.ref.id; await until(async () => (await snapshot(server, token, id)).status === "idle"); const state = await snapshot(server, token, id); connection.subscribe(state);
  const route = "/api/sessions/" + state.ref.id + "/control";
  const body = { requestId: randomUUID(), expectedEpoch: state.cursor.epoch, expectedRevision: state.controlRevision, command: { type: "prompt", message: "/pane-test-resume " + target } };
  const switching = request(server, token, route, body);
  const prompt = await until(() => connection.messages.find(m => m.type === "project_trust")); assert.equal(path.resolve(prompt.request.cwd), path.resolve(cwd));
  const timedOut = await switching; assert.equal(timedOut.code, 200); assert.deepEqual(timedOut.value, { status: "pending" });
  await delay(6000); // 同时跨过原 bridge 十秒期限，信任询问仍不能杀掉写者。
  assert.deepEqual((await request(server, token, route, body)).value, { status: "pending" });
  const held = await probeSessionWriterLock(state.sessionFile); assert.equal(held.held, true); assert.equal(await isSameProcess(held.record.writer), "alive");
  await request(server, token, "/api/trust/" + prompt.request.id, { requestId: randomUUID(), decision: { trusted: false, remember: false } });
  const result = await until(async () => { const r = await request(server, token, route, body); return r.value.status !== "pending" && r; });
  assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.status, "accepted");
  assert.deepEqual((await request(server, token, route, body)).value, result.value);
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
