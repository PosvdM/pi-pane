// 固定 hostkit 通过 cause/errors 交付报告；部分原生清理失败只有多错误聚合或消息，没有专用错误码。
export function carriesUnconfirmedCleanup(error: unknown): boolean {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const item = value as { coverage?: unknown; steps?: unknown; leftovers?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
    // 即使报告完整，随拒绝交付仍可能表示恢复身份查询失败；后续成功不能撤销该失败。
    if (typeof item.coverage === "string" && Array.isArray(item.steps) && Array.isArray(item.leftovers)) return true;
    if (Array.isArray(item.errors)) {
      // spawnManaged 的启动回收聚合没有稳定消息或错误码；多错误拒绝保守视为清理未确认。
      if (item.errors.length > 1) return true;
      pending.push(...item.errors);
    }
    if (typeof item.message === "string" && /^(Cannot (?:stop failed session writer|release failed session (?:lock|acquisition|probe)|clean up lock record|recover session writers)|stop after release failure:|release: writer exit cannot be confirmed|启动回收|恢复查询失败，清理结果见 cause)/.test(item.message)) return true;
    pending.push(item.cause);
  }
  return false;
}

export function observeHostkitSync<T>(operation: () => T, onFailure?: (error: unknown) => void, cleanup = false): T {
  try { return operation(); }
  catch (error) {
    if (cleanup || carriesUnconfirmedCleanup(error)) onFailure?.(error);
    throw error;
  }
}
export async function observeHostkit<T>(operation: () => Promise<T>, onFailure?: (error: unknown) => void, cleanup = false): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (cleanup || carriesUnconfirmedCleanup(error)) onFailure?.(error);
    throw error;
  }
}
