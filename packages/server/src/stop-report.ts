import { isSameProcess, type ProcessIdentity, type StopReport } from "pi-hostkit";
import { assert } from "./errors.js";

export function checkStopReport(report: StopReport): void {
  assert(["job_object", "cgroup", "snapshot_visible"].includes(report.coverage), "stopCoverage", "停止报告的覆盖范围无效", 503);
  const cleanupFailed = report.steps.some((step) => step.step === "snapshot cleanup" && !step.ok);
  const verified = report.steps.some((step) => step.step === "verify" && step.ok);
  // 发信号失败不等于仍有残留；仅在独立最终复查通过后接受，快照枚举失败仍按不完整处理。
  assert(!report.leftovers.length && !report.steps.some((step) => !step.ok && ["snapshot", "verify"].includes(step.step)) && (!cleanupFailed || verified), "stopIncomplete", "仍有存活或无法确认退出的进程，保留写锁", 503);
}
export async function verifyStopped(identity: ProcessIdentity, report: StopReport): Promise<void> {
  checkStopReport(report);
  assert(await isSameProcess(identity) === "gone", "stopIncomplete", "pi 尚未确认退出，保留写锁", 503);
}
