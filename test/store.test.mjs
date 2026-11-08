import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { PiStore } from "../packages/server/dist/store.js";
import { piFixture } from "./fixtures/helpers.mjs";
import { startServer, pair, open, request } from "./fixtures/client.mjs";
async function session(file, id, cwd) {
 await mkdir(path.dirname(file), { recursive: true });
 await writeFile(file, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "message", id: "message-" + id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: id, timestamp: Date.now() } }) + "\n");
 await utimes(file, new Date(0), new Date(0));
}
test("会话目录按环境、项目、全局设置取值，默认列表包括终端的项目分目录", { timeout: 60000 }, async () => {
 const f = await piFixture();
 try {
  const env = { ...f.env }; delete env.PI_CODING_AGENT_SESSION_DIR;
  const store = new PiStore(f.install, f.agentDir, path.join(f.root, "tmp"), env);
  const settings = path.join(f.agentDir, "settings.json"); const original = JSON.parse(await readFile(settings, "utf8"));
  await writeFile(settings, JSON.stringify({ ...original, sessionDir: "global-sessions" })); assert.equal(await store.sessionDir(f.cwd), path.join(f.cwd, "global-sessions"));
  await mkdir(path.join(f.cwd, ".pi")); await writeFile(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ sessionDir: "project-sessions" })); assert.equal(await store.sessionDir(f.cwd), path.join(f.cwd, "project-sessions"));
  env.PI_CODING_AGENT_SESSION_DIR = path.join(f.root, "environment-sessions"); assert.equal(await store.sessionDir(f.cwd), env.PI_CODING_AGENT_SESSION_DIR);
  delete env.PI_CODING_AGENT_SESSION_DIR; await writeFile(settings, JSON.stringify(original)); await writeFile(path.join(f.cwd, ".pi/settings.json"), "{}");
  await session(path.join(f.agentDir, "sessions", "--encoded-cwd--", "terminal.jsonl"), "terminal", f.cwd);
  assert.ok((await store.list()).some(row => row.id === "terminal"));
 } finally { await f.cleanup(); }
});

test("已知项目目录在重启后保留，项目自定义 sessionDir 的历史仍可列出", { timeout: 60000 }, async () => {
 const f = await piFixture(); let server;
 try {
  const env = { ...f.env }; delete env.PI_CODING_AGENT_SESSION_DIR;
  await mkdir(path.join(f.cwd, ".pi")); const custom = path.join(f.root, "project-history");
  await writeFile(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ sessionDir: custom }));
  await session(path.join(custom, "historical.jsonl"), "historical", f.cwd);
  server = await startServer(f, { env }); let token = await pair(server); await open(server, token, f, { sessionFile: path.join(custom, "historical.jsonl") });
  assert.ok((await request(server, token, "/api/sessions")).value.sessions.some(row => row.id === "historical"));
  await server.close(); server = await startServer(f, { env }); token = await pair(server);
  assert.ok((await request(server, token, "/api/sessions")).value.sessions.some(row => row.id === "historical"));
 } finally { await server?.close(); await f.cleanup(); }
});
