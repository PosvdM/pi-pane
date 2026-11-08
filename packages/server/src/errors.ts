export class PaneError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly detail?: unknown) { super(message); }
}
export function assert(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new PaneError(code, message, status);
}
export function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  assert(Number.isSafeInteger(result) && result > 0 && result <= 2 ** 31 - 1, "invalidConfig", "超时必须为正整数毫秒");
  return result;
}
