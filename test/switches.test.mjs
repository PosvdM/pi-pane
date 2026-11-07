import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { writeFile, utimes, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { probeSessionWriterLock } from "pi-hostkit";
import { piFixture, until, providerPath } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";
const commandPath = fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url));
const script = { fallback: { segments: [{ type: "text", text: "完成" }] } };

test("扩展运行中切换会话：旧订阅得到替换事件，旧 epoch 不能向新会话发送，重复 start 幂等", { timeout: 60000 }, async () => {
 const f = await piFixture({ ...script, routes: [{ when: { lastUser: "源会话" }, reply: { segments: [{ type: "text", text: "仍在运行" }, { type: "hang" }] } }] }); const server = await startServer(f, { extraExtensions: [providerPath, commandPath] }); let connection;
 try {
  const token = await pair(server); const initial = await open(server, token, f);
  const first = await control(server, token, initial, { type: "prompt", message: "源会话" }); assert.equal(first.code, 200, JSON.stringify(first));
  const id = first.value.snapshot.ref.id; await until(async () => JSON.stringify((await snapshot(server, token, id)).inFlight).includes("仍在运行"));
  const old = await snapshot(server, token, id); connection = await connect(server, token); connection.subscribe(old);
  const switched = await control(server, token, old, { type: "prompt", message: "/pane-test-new" }); assert.equal(switched.code, 200, JSON.stringify(switched));
  const event = await until(() => connection.messages.find(m => m.event?.type === "pane_session_replaced")); const newId = event.event.newRef.id;
  await until(async () => (await snapshot(server, token, newId)).readonly === false);
  assert.equal((await snapshot(server, token, id)).readonly, true);
  const stale = await control(server, token, old, { type: "prompt", message: "不能进入新会话" }); assert.equal(stale.code, 409);
  let current = await snapshot(server, token, newId); const sent = await control(server, token, current, { type: "prompt", message: "新会话消息" }); assert.equal(sent.code, 200, JSON.stringify(sent));
  await until(async () => (await snapshot(server, token, newId)).status === "idle");
  const currentFile = (await snapshot(server, token, newId)).sessionFile;
  assert.equal((await probeSessionWriterLock(old.sessionFile)).held, false); assert.equal((await probeSessionWriterLock(currentFile)).held, true);
  // reload 只换 epoch，不换会话身份；同实例的两次 session_start 不得重复释放旧锁。
  current = await snapshot(server, token, newId); const reloaded = await control(server, token, current, { type: "prompt", message: "/pane-test-reload" }); assert.equal(reloaded.code, 200, JSON.stringify(reloaded));
  const after = await until(async () => { const s = await snapshot(server, token, newId); return s.cursor.epoch !== current.cursor.epoch && !s.readonly && s; });
  assert.equal((await probeSessionWriterLock(after.sessionFile)).held, true);
  assert.equal((await readFile(after.sessionFile, "utf8")).includes("不能进入新会话"), false);
 } finally { connection?.close(); await server.close(); await f.cleanup(); }
});

test("其他进程以 pi-agora 身份持有同一 hostkit 写锁，pane 只读打开且不拉起写者", { timeout: 60000 }, async () => {
 const f = await piFixture(script); const file = f.sessionPath("external"); let child; const server = await startServer(f);
 try {
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "external", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n"); await utimes(file, new Date(0), new Date(0));
  child = fork(new URL("./fixtures/lock-host.mjs", import.meta.url), [], { env: { ...f.env, SESSION_FILE: file }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("外部锁未就绪")), 10000); child.once("message", () => { clearTimeout(timer); resolve(); }); child.once("error", reject); });
  const token = await pair(server); const opened = await open(server, token, f, { sessionFile: file }); assert.equal(opened.readonly, true); assert.equal(opened.readonlyReason, "externalWriter"); assert.equal(opened.heldBy, "pi-agora");
  const sent = await control(server, token, opened, { type: "prompt", message: "拒绝写入" }); assert.equal(sent.code, 409); assert.equal(sent.value.error, "externalWriter");
  assert.equal((await probeSessionWriterLock(file)).record.host.app, "pi-agora");
  const exited = new Promise(resolve => child.once("exit", resolve)); child.send("release"); await exited;
 } finally { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await server.close(); await f.cleanup(); }
});
