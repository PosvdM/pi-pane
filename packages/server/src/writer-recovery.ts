import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock, type RecoverOptions, type SessionWriterLock } from "pi-hostkit";
import { checkStopReport } from "./stop-report.js";
import { assert, PaneError } from "./errors.js";
import { fileKey } from "./store.js";

// pane 拒绝已恢复的报告时保留内核锁；hostkit failed/throw 已自行解锁，隔离依赖持久标记和旧共享记录。
const quarantined = new Map<string, { lock: SessionWriterLock; error: unknown }>();
export async function acquireRecoveredWriter(file: string, home: string, instanceId: string, opts: RecoverOptions | undefined,
  acquire: typeof acquireSessionWriterLock = acquireSessionWriterLock, onFailure?: (error: unknown) => void): Promise<SessionWriterLock> {
  const key = createHash("sha256").update(fileKey(file)).digest("hex");
  const diagnostic = path.join(home, "recovery", key + ".json");
  let blocked = false;
  try { await readFile(diagnostic); blocked = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  assert(!blocked, "stopIncomplete", "上一次恢复报告不完整，请核查遗留进程及恢复记录", 503);
  const lock = await acquire(file, { app: "pi-pane", identity: currentProcessIdentity(instanceId) });
  assert(isSessionWriterLock(lock), "externalWriter", "会话已由其他宿主托管，只能只读打开", 409);
  let recovered = false;
  try {
    const result = await lock.recoverPreviousWriter(opts);
    assert(result !== "failed", "stopIncomplete", "上一个写者恢复失败，请核查遗留进程及恢复记录", 503);
    recovered = true;
    for (const report of lock.recoveryReports) checkStopReport(report);
  } catch (error) {
    quarantined.set(fileKey(file), { lock, error });
    // 在持久化隔离记录之前通知本实例；记录写入失败也不能丢失未确认的恢复。
    onFailure?.(error);
    let recordError: unknown;
    // 仅成功返回的恢复仍持锁并写入 starting；failed/throw 保留 hostkit 未改写的旧记录。
    if (recovered) try { await lock.update({ state: "stopping", writer: lock.previous?.writer }); } catch (failure) { recordError = failure; }
    await mkdir(path.dirname(diagnostic), { recursive: true });
    const temporary = diagnostic + ".tmp";
    await writeFile(temporary, JSON.stringify({ sessionFile: lock.sessionFile, previous: lock.previous, reports: lock.recoveryReports,
      error: String(error), ...(recordError ? { recordError: String(recordError) } : {}) }), { mode: 0o600 });
    await rename(temporary, diagnostic);
    throw new PaneError("stopIncomplete", "写者恢复未完成，请核查遗留进程及恢复记录", 503);
  }
  return lock;
}
