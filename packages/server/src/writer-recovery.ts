import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock, type RecoverOptions, type SessionWriterLock } from "pi-hostkit";
import { checkStopReport } from "./stop-report.js";
import { assert } from "./errors.js";
import { fileKey } from "./store.js";

// 不完整停止不能证明整棵进程树退出；保留内核锁，直到宿主退出，不走普通 release。
const quarantined = new Map<string, { lock: SessionWriterLock; error: unknown }>();
export async function acquireRecoveredWriter(file: string, home: string, instanceId: string, opts: RecoverOptions | undefined,
  acquire: typeof acquireSessionWriterLock = acquireSessionWriterLock): Promise<SessionWriterLock> {
  const key = createHash("sha256").update(fileKey(file)).digest("hex");
  const diagnostic = path.join(home, "recovery", key + ".json");
  let blocked = false;
  try { await readFile(diagnostic); blocked = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  assert(!blocked, "stopIncomplete", "上一次恢复报告不完整，请核查遗留进程及恢复记录", 503);
  const lock = await acquire(file, { app: "pi-pane", identity: currentProcessIdentity(instanceId) });
  assert(isSessionWriterLock(lock), "externalWriter", "会话已由其他宿主托管，只能只读打开", 409);
  const result = await lock.recoverPreviousWriter(opts);
  try { for (const report of lock.recoveryReports) checkStopReport(report); }
  catch (error) {
    quarantined.set(fileKey(file), { lock, error });
    // hostkit 在恢复返回成功后写入 starting；补回旧 writer 身份，不能登记新 writer。
    if (result !== "failed") await lock.update({ state: "stopping", writer: lock.previous?.writer });
    await mkdir(path.dirname(diagnostic), { recursive: true });
    const temporary = diagnostic + ".tmp";
    await writeFile(temporary, JSON.stringify({ sessionFile: lock.sessionFile, previous: lock.previous, reports: lock.recoveryReports, error: String(error) }), { mode: 0o600 });
    await rename(temporary, diagnostic);
    throw error;
  }
  assert(result !== "failed", "recoveryFailed", "上一个写者状态不明，请确认没有遗留的 pi 后重试", 409);
  return lock;
}
