import type {
  ActionInvocation, ActionResult, ActionSpec, ActionTarget, FormAnswers, FormRemovedReason,
  FormSpec, FormSubmission, FormSubmitResult, PanePlugin, RequestOrigin,
  SendResult, SessionInput, SessionRef, SessionSendRequest,
} from "@pi-pane/plugin-api";
import { assert, duration, PaneError } from "../errors.js";

interface Options {
  get: (source: string) => PanePlugin;
  call: <T>(source: string, method: string, fn: (plugin: PanePlugin) => T | Promise<T>, timeoutMs?: number) => Promise<T>;
  emit: (message: unknown) => void;
  timeoutMs?: number;
  now?: () => number;
}
type Result = ActionResult | FormSubmitResult | SendResult;
type Kind = "action" | "form" | "send";
interface Operation {
  source: string;
  fingerprint: string;
  result?: Result;
  running?: Promise<Result>;
  finalAt?: number;
}
type FormEvent = { form: FormSpec } | { formId: string; reason: FormRemovedReason };
interface Alignment { events: FormEvent[]; cancelled: boolean; promise: Promise<void> }

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_UNFINISHED = 1024;
const keyOf = (...parts: (string | number)[]) => JSON.stringify(parts);
const unknownResult = () => ({ status: "pending" as const, message: "结果未知，请使用同一请求标识查询" });
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function valid(condition: unknown): asserts condition { assert(condition, "invalidRequest", "操作参数无效"); }

// 指纹使用排序后的 JSON；拒绝循环引用、非 JSON 值和过深的输入。
function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  let count = 0;
  function visit(item: unknown, depth: number): string {
    valid(depth <= 32 && ++count <= 100_000);
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") { valid(Number.isFinite(item)); return JSON.stringify(item); }
    valid(typeof item === "object" && item !== null && !ancestors.has(item));
    valid(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
    ancestors.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, entry => visit(entry, depth + 1)).join(",")}]`
      : `{${Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    ancestors.delete(item);
    return result;
  }
  const result = visit(value, 0);
  valid(result.length <= 16 * 1024 * 1024);
  return result;
}
function snapshot<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function requestFingerprint(kind: Kind, request: object): string {
  const { origin: _origin, expectedRevision: _revision, ...business } = request as Record<string, unknown>;
  return canonical({ kind, request: business });
}
function checkOrigin(origin: RequestOrigin): void {
  valid(isObject(origin) && origin.client === "browser" && isId(origin.connectionId)
    && typeof origin.receivedAt === "string" && Number.isFinite(Date.parse(origin.receivedAt))
    && (origin.deviceId === undefined || isId(origin.deviceId)));
}
function checkTarget(target: ActionTarget | undefined): void {
  if (target === undefined) return;
  valid(isObject(target));
  switch (target.type) {
    case "global": return;
    case "node": valid(isId(target.nodeId)); return;
    case "panelRow": valid(isId(target.panelId) && isId(target.rowId) && (target.nodeId === undefined || isId(target.nodeId))); return;
    default: valid(false);
  }
}
function checkAnswers(answers: FormAnswers): void {
  valid(isObject(answers) && Array.isArray(answers.answers));
  for (const answer of answers.answers) valid(isObject(answer) && isId(answer.id)
    && Array.isArray(answer.selected) && answer.selected.every((entry: unknown) => typeof entry === "string")
    && (answer.custom === undefined || typeof answer.custom === "string"));
  function fields(value: unknown): void {
    valid(isObject(value));
    for (const entry of Object.values(value)) {
      if (typeof entry === "string") continue;
      valid(Array.isArray(entry));
      entry.forEach(fields);
    }
  }
  if (answers.fields !== undefined) fields(answers.fields);
}
function checkForm(source: string, value: FormSpec): void {
  valid(isObject(value) && isId(value.id) && value.source === source && isRevision(value.revision)
    && typeof value.title === "string" && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)));
  valid(value.questions === undefined || (Array.isArray(value.questions) && value.questions.length <= 5
    && value.questions.every(question => isObject(question) && isId(question.id) && typeof question.question === "string"
      && (question.options === undefined || (Array.isArray(question.options) && question.options.every(option => isObject(option) && typeof option.label === "string"))))));
  function fields(items: unknown): void {
    valid(Array.isArray(items));
    for (const field of items) {
      valid(isObject(field) && isId(field.id) && typeof field.label === "string"
        && ["text", "textarea", "number", "select", "checkbox", "group"].includes(String(field.type)));
      if (field.fields !== undefined) fields(field.fields);
    }
  }
  if (value.fields !== undefined) fields(value.fields);
}
function checkResult(kind: Kind, source: string, result: Result): void {
  valid(isObject(result) && typeof result.status === "string");
  const allowed = kind === "action" ? ["ok", "failed", "pending", "needsInput", "idempotencyConflict"]
    : kind === "form" ? ["accepted", "pending", "alreadyHandled", "stale", "failed", "idempotencyConflict"]
      : ["accepted", "pending", "rejected", "conflict", "idempotencyConflict"];
  valid(allowed.includes(result.status));
  if (result.status === "failed" || result.status === "rejected" || result.status === "idempotencyConflict") valid(typeof result.message === "string");
  if (result.status === "conflict") valid(isRevision(result.controlRevision));
  if (result.status === "needsInput") checkForm(source, result.followUpForm);
  if (result.status === "stale") checkForm(source, result.form);
}

export class PluginOperations {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly operations = new Map<string, Operation>();
  private readonly forms = new Map<string, FormSpec>();
  private readonly claims = new Map<string, Operation>();
  private readonly alignments = new Map<string, Alignment>();
  private readonly unavailableSources = new Set<string>();
  private readonly waits = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: Options) {
    this.timeoutMs = Math.min(duration(options.timeoutMs, 10_000), 60_000);
    this.now = options.now ?? Date.now;
  }

  async invoke(source: string, inv: ActionInvocation, origin: RequestOrigin): Promise<ActionResult> {
    this.ensureOpen(source);
    inv = snapshot(inv);
    valid(isObject(inv) && isId(inv.actionId) && isId(inv.idempotencyKey));
    checkTarget(inv.target); checkOrigin(origin);
    if (inv.input !== undefined) checkAnswers(inv.input);
    valid(inv.formId === undefined || isId(inv.formId));
    valid(inv.formRevision === undefined || isRevision(inv.formRevision));
    const fingerprint = requestFingerprint("action", inv);
    const cached = this.cached<ActionResult>(source, inv.idempotencyKey, fingerprint);
    if (cached) return cached;
    const action = await this.action(source, inv.actionId);
    return this.transact(source, inv.idempotencyKey, fingerprint, "action", () => {
      const plugin = this.plugin(source);
      assert(plugin.actions, "unsupported", "插件不支持动作", 404);
      return plugin.actions.invoke(snapshot(inv), origin);
    }, Math.min(duration(action.timeoutMs, this.timeoutMs), 60_000));
  }

  async resolveForm(source: string, actionId: string, target?: ActionTarget): Promise<FormSpec | null> {
    this.ensureOpen(source); valid(isId(actionId));
    target = target === undefined ? undefined : snapshot(target); checkTarget(target);
    await this.action(source, actionId);
    const form = await this.options.call(source, "actions.resolveForm", plugin => plugin.actions?.resolveForm?.(actionId, target === undefined ? undefined : snapshot(target)) ?? null);
    this.ensureOpen(source);
    if (form === null) return null;
    const result = snapshot(form); checkForm(source, result);
    return result;
  }

  async align(source: string): Promise<void> {
    this.ensureOpen(source);
    const existing = this.alignments.get(source);
    if (existing) return existing.promise;
    this.unavailableSources.delete(source);
    const state: Alignment = { events: [], cancelled: false, promise: Promise.resolve() };
    this.alignments.set(source, state);
    state.promise = Promise.resolve().then(async () => {
      try {
        const result = snapshot(await this.options.call(source, "forms.pending", plugin => plugin.forms?.pending() ?? []));
        valid(Array.isArray(result));
        result.forEach(form => checkForm(source, form));
        if (state.cancelled || this.closed) return;
        const ids = new Set(result.map(form => form.id));
        for (const form of this.pending(source)) {
          // 待处理列表以插件快照为准；事务占用保留到最终结果或显式移除事件。
          if (!ids.has(form.id)) this.remove(source, form.id, "withdrawn", false);
        }
        for (const form of result.sort(compareForms)) this.add(source, form);
      } finally {
        if (this.alignments.get(source) === state) this.alignments.delete(source);
        if (!state.cancelled && !this.closed) for (const event of state.events) this.apply(source, event);
      }
    });
    return state.promise;
  }

  formAdded(source: string, form: FormSpec): void {
    if (this.closed || this.unavailableSources.has(source)) return;
    valid(isId(source)); form = snapshot(form); checkForm(source, form);
    this.queueOrApply(source, { form });
  }

  formRemoved(source: string, formId: string, reason: FormRemovedReason): void {
    if (this.closed) return;
    valid(isId(source) && isId(formId) && ["handled", "cancelled", "expired", "withdrawn"].includes(reason));
    this.queueOrApply(source, { formId, reason });
  }

  pending(source?: string): FormSpec[] {
    return [...this.forms.values()].filter(form => source === undefined || form.source === source).sort(compareForms).map(snapshot);
  }

  async submit(source: string, req: FormSubmission, origin: RequestOrigin): Promise<FormSubmitResult> {
    this.ensureOpen(source); req = snapshot(req);
    valid(isObject(req) && isId(req.formId) && isId(req.idempotencyKey) && isRevision(req.revision));
    valid(isObject(req.outcome)); checkOrigin(origin);
    if (req.outcome.status === "submitted") checkAnswers(req.outcome.values);
    else valid(req.outcome.status === "cancelled" && (req.outcome.reason === undefined || typeof req.outcome.reason === "string"));
    const fingerprint = requestFingerprint("form", req);
    const claimKey = keyOf(source, req.formId, req.revision);
    return this.transact(source, req.idempotencyKey, fingerprint, "form", () => {
      const plugin = this.plugin(source);
      assert(plugin.forms, "unsupported", "插件不支持表单提交", 404);
      return Promise.resolve(plugin.forms.submit(snapshot(req), origin)).then(result => {
        if (result?.status === "stale") valid(result.form?.id === req.formId);
        return result;
      });
    }, this.timeoutMs, operation => {
      // 同一请求的 pending 查询可以继续；新的标签页只能领取未被占用的版本。
      if (operation.result?.status === "pending") return;
      const form = this.forms.get(keyOf(source, req.formId));
      if (!form) return { status: "alreadyHandled" };
      if (form.revision !== req.revision) return { status: "stale", form: snapshot(form) };
      if (this.claims.has(claimKey) && this.claims.get(claimKey) !== operation) return { status: "alreadyHandled" };
      this.claims.set(claimKey, operation);
    }, (operation, result) => {
      if (result.status === "stale" && this.forms.has(keyOf(source, req.formId)) && !this.closed && !this.unavailableSources.has(source)) this.add(source, result.form);
      if (result.status !== "pending" && result.status !== "accepted" && result.status !== "alreadyHandled"
        && this.claims.get(claimKey) === operation) this.claims.delete(claimKey);
    });
  }

  async send(source: string, ref: SessionRef, input: SessionInput, req: SessionSendRequest): Promise<SendResult> {
    this.ensureOpen(source); ref = snapshot(ref); input = snapshot(input);
    valid(isObject(req));
    const { origin, ...business } = req;
    const request = snapshot(business);
    valid(isObject(ref) && ref.source === source && isId(ref.id));
    valid(isObject(input) && typeof input.text === "string"
      && (input.delivery === undefined || input.delivery === "steer" || input.delivery === "followUp")
      && (input.images === undefined || (Array.isArray(input.images) && input.images.every(item => isObject(item) && isId(item.mimeType) && typeof item.data === "string"))));
    valid(isId(request.idempotencyKey) && (request.expectedRevision === undefined || isRevision(request.expectedRevision)));
    checkOrigin(origin);
    const fingerprint = canonical({ kind: "send", ref, input });
    return this.transact(source, request.idempotencyKey, fingerprint, "send", () => {
      const plugin = this.plugin(source);
      assert(plugin.sessions?.send, "unsupported", "插件不支持发送消息", 404);
      return plugin.sessions.send(snapshot(ref), snapshot(input), { ...snapshot(request), origin });
    }, this.timeoutMs);
  }

  unavailable(source: string): void {
    valid(isId(source));
    this.unavailableSources.add(source);
    const state = this.alignments.get(source);
    if (state) { state.cancelled = true; state.events.length = 0; this.alignments.delete(source); }
    for (const form of this.pending(source)) this.remove(source, form.id, "withdrawn");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.alignments.values()) state.cancelled = true;
    this.alignments.clear(); this.forms.clear(); this.claims.clear(); this.operations.clear();
    for (const finish of this.waits) finish();
    this.waits.clear();
  }

  private ensureOpen(source: string): void {
    assert(!this.closed, "closed", "插件操作服务已关闭", 503); valid(isId(source));
  }

  private plugin(source: string): PanePlugin {
    const plugin = this.options.get(source);
    assert(plugin.id === source, "invalidPlugin", "插件来源不匹配", 502);
    return plugin;
  }

  private async action(source: string, actionId: string): Promise<ActionSpec> {
    const actions = snapshot(await this.options.call(source, "actions.list", plugin => plugin.actions?.list() ?? []));
    valid(Array.isArray(actions));
    const action = actions.find(item => item.id === actionId);
    assert(action, "actionNotFound", "动作不存在", 404);
    assert(action.source === source, "invalidPlugin", "动作来源不匹配", 502);
    return action;
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const [key, operation] of this.operations) {
      if (operation.finalAt === undefined || operation.finalAt >= cutoff) continue;
      this.operations.delete(key);
      for (const [claim, owner] of this.claims) if (owner === operation) this.claims.delete(claim);
    }
  }

  private cached<R extends Result>(source: string, key: string, fingerprint: string): R | undefined {
    this.prune();
    const operation = this.operations.get(keyOf(source, key));
    if (!operation) return;
    if (operation.fingerprint !== fingerprint) return { status: "idempotencyConflict", message: "请求标识已用于其他操作内容" } as R;
    if (operation.running) return unknownResult() as R;
    if (operation.finalAt !== undefined) return snapshot(operation.result) as R;
  }

  private async transact<R extends Result>(
    source: string, key: string, fingerprint: string, kind: Kind, run: () => R | Promise<R>, timeoutMs: number,
    prepare?: (operation: Operation) => FormSubmitResult | undefined,
    settled?: (operation: Operation, result: Result) => void,
  ): Promise<R> {
    this.ensureOpen(source);
    const cached = this.cached<R>(source, key, fingerprint);
    if (cached) return cached;
    const operationKey = keyOf(source, key);
    let operation = this.operations.get(operationKey);
    if (!operation) {
      const unfinished = [...this.operations.values()].filter(item => item.finalAt === undefined).length;
      assert(unfinished < MAX_UNFINISHED, "tooManyOperations", "待确认的操作过多，请稍后重试", 429);
      operation = { source, fingerprint };
      this.operations.set(operationKey, operation);
    }
    const record = operation;
    const immediate = prepare?.(record);
    if (immediate) {
      record.result = snapshot(immediate); record.finalAt = this.now();
      return snapshot(immediate) as R;
    }
    // 原始事务始终被观察；HTTP 等待结束不改变其状态，也不取消插件执行。
    const running = Promise.resolve().then(run).then(result => {
      const copy = snapshot(result); checkResult(kind, source, copy); return copy;
    }).catch((error): Result => {
      try { console.error(`插件 ${source} 的 ${kind} 操作失败：`, error); } catch { /* 日志故障不影响事务结果。 */ }
      return kind === "send" ? { status: "rejected", message: "插件操作失败" } : { status: "failed", message: "插件操作失败" };
    }).then(result => {
      record.result = result; record.running = undefined;
      if (result.status !== "pending") record.finalAt = this.now();
      settled?.(record, result);
      return result;
    });
    record.running = running;
    return new Promise<R>(resolve => {
      let done = false;
      const finish = (result: Result = unknownResult()) => {
        if (done) return;
        done = true; clearTimeout(timer); this.waits.delete(stop); resolve(snapshot(result) as R);
      };
      const stop = () => finish();
      const timer = setTimeout(() => {
        try { console.warn(`插件 ${source} 的 ${kind} 操作等待超过 ${timeoutMs} 毫秒，结果未知`); } catch { /* 日志故障不影响超时返回。 */ }
        stop();
      }, timeoutMs);
      this.waits.add(stop);
      // 同步和异步异常均转为该操作的结果，不向主会话传播拒绝。
      void running.then(finish, () => finish(kind === "send"
        ? { status: "rejected", message: "插件操作失败" } : { status: "failed", message: "插件操作失败" }));
    });
  }

  private queueOrApply(source: string, event: FormEvent): void {
    const state = this.alignments.get(source);
    if (state) state.events.push(event);
    else this.apply(source, event);
  }

  private apply(source: string, event: FormEvent): void {
    if ("form" in event) this.add(source, event.form);
    else this.remove(source, event.formId, event.reason);
  }

  private add(source: string, form: FormSpec): void {
    const key = keyOf(source, form.id);
    const current = this.forms.get(key);
    if (current && current.revision >= form.revision) return;
    const copy = snapshot(form);
    if (current) copy.createdAt = current.createdAt;
    this.forms.set(key, copy);
    this.emit({ type: "form", form: copy });
  }

  private remove(source: string, formId: string, reason: FormRemovedReason, releaseClaims = true): void {
    this.forms.delete(keyOf(source, formId));
    if (releaseClaims) for (const claim of this.claims.keys()) {
      const [owner, id] = JSON.parse(claim) as [string, string, number];
      if (owner === source && id === formId) this.claims.delete(claim);
    }
    this.emit({ type: "formRemoved", source, formId, reason });
  }

  private emit(message: unknown): void {
    if (this.closed) return;
    try { this.options.emit(snapshot(message)); } catch { /* 通知异常不影响插件事务。 */ }
  }
}

function compareForms(a: FormSpec, b: FormSpec): number {
  const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
}
