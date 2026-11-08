#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PaneServer, type PaneServerOptions } from "./server.js";

const home = process.env.PI_PANE_HOME ?? path.join(homedir(), ".pi/pane");
let config: Partial<PaneServerOptions> = {};
try { config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const server = await PaneServer.start({ home, port: config.port, piPath: config.piPath, idleReclaimMs: config.idleReclaimMs,
  webRoot: config.webRoot ?? fileURLToPath(new URL("../../web/dist", import.meta.url)) });
for (const diagnostic of server.sessions.recoveryDiagnostics) console.warn(diagnostic);
const printCode = () => console.log(`配对地址：${server.origin}/#code=${server.auth.issuePairCode()}\n配对码使用一次或十分钟后失效。按 Enter 生成新码。`);
printCode();
const input = process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined;
input?.on("line", printCode);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return; stopping = true; input?.close();
  try { await server.close(); } catch (error) { console.error("部分进程未确认停止，保留恢复记录：", error); process.exitCode = 1; }
}
process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
