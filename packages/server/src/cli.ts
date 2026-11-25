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
const server = await PaneServer.start({ home, port: config.port, piPath: config.piPath, idleReclaimMs: config.idleReclaimMs, plugins: config.plugins,
  webRoot: config.webRoot ?? fileURLToPath(new URL("../../web/dist", import.meta.url)) });
let input: ReturnType<typeof createInterface> | undefined;
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return; stopping = true; input?.close();
  try { await server.close(); } catch (error) { console.error("部分进程未确认停止，保留恢复记录：", error); process.exitCode = 1; }
  // server.close() 有界返回，但挂起的文件 I/O 或未释放的句柄仍可能让事件循环不结束；1 秒后强制退出。计时器不阻止正常退出。
  setTimeout(() => process.exit(), 1000).unref();
}
// 先登记信号处理再输出配对地址：看到配对地址后按 Ctrl+C 一定经过 server.close()。
process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
for (const diagnostic of server.sessions.recoveryDiagnostics) console.warn(diagnostic);
const printCode = () => console.log(`配对地址：${server.origin}/#code=${server.auth.issuePairCode()}\n配对码使用一次或十分钟后失效。按 Enter 生成新码。`);
printCode();
input = process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined;
input?.on("line", printCode);
