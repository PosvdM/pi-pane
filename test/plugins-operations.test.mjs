import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PluginOperations } from "../packages/server/dist/plugins/operations.js";

const origin = { client: "browser", connectionId: "tab-a", receivedAt: "2026-06-02T00:00:00.000Z" };
const otherOrigin = { ...origin, connectionId: "tab-b" };
const invocation = (key = "action-key", extra = {}) => ({ actionId: "p.run", idempotencyKey: key, ...extra });
const form = (id = "form", revision = 1, extra = {}) => ({
  id, source: "p", revision, title: id, createdAt: "2026-06-02T00:00:00.000Z", ...extra,
});
const submission = (key = "form-key", revision = 1, extra = {}) => ({
  formId: "form", revision, outcome: { status: "submitted", values: { answers: [] } }, idempotencyKey: key, ...extra,
});
const sendReq = (key = "send-key", extra = {}) => ({ idempotencyKey: key, origin, ...extra });
const ref = { source: "p", id: "session" };
const input = { text: "消息" };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(t, options = {}) {
  const events = [], calls = [];
  const plugin = {
    id: "p", paneProtocol: [1, 1], activate: async () => {},
    actions: {
      list: () => [{ id: "p.run", source: "p", title: "执行", scope: ["global"] }],
      invoke: async () => ({ status: "ok" }),
      resolveForm: async () => form("ephemeral"),
    },
    forms: { pending: async () => [], submit: async () => ({ status: "accepted" }) },
    sessions: { send: async () => ({ status: "accepted" }) },
  };
  const plugins = new Map([["p", plugin]]);
  const operations = new PluginOperations({
    get: source => {
      const result = plugins.get(source);
      if (!result) throw new Error("插件不可用");
      return result;
    },
    call: async (source, method, fn) => {
      calls.push(method);
      const result = plugins.get(source);
      if (!result) throw new Error("插件不可用");
      return fn(result);
    },
    emit: message => events.push(message), timeoutMs: 10, ...options,
  });
  t.after(() => operations.close());
  return { operations, plugin, plugins, events, calls };
}

for (const kind of ["action", "form", "send"]) {
  function setup(t) {
    const h = harness(t);
    const { operations: ops, plugin } = h;
    ops.formAdded("p", form());
    const run = (key = "key", changed = false, who = origin) => kind === "action"
      ? ops.invoke("p", invocation(key, { input: { answers: [], fields: { value: changed ? "二" : "一" } } }), who)
      : kind === "form" ? ops.submit("p", submission(key, 1, { outcome: { status: "cancelled", reason: changed ? "二" : "一" } }), who)
        : ops.send("p", ref, { text: changed ? "二" : "一" }, sendReq(key, { origin: who, expectedRevision: who === origin ? 1 : 2 }));
    const success = kind === "action" ? { status: "ok" } : { status: "accepted" };
    const set = fn => {
      if (kind === "action") plugin.actions.invoke = fn;
      else if (kind === "form") plugin.forms.submit = fn;
      else plugin.sessions.send = fn;
    };
    return { ...h, run, success, set };
  }

  test(`${kind}：真正迟到的结果在超时后缓存，重复请求不重复执行`, async t => {
    const { run, set, success, calls } = setup(t);
    const gate = deferred(); let count = 0;
    set(() => { count++; return gate.promise; });
    const first = await run();
    assert.equal(first.status, "pending");
    assert.match(first.message, /结果未知/);
    assert.equal((await run()).status, "pending");
    assert.equal((await run("key", true)).status, "idempotencyConflict");
    assert.equal(count, 1);
    gate.resolve(success);
    await delay(0);
    assert.deepEqual(await run("key", false, otherOrigin), success);
    assert.equal(count, 1);
    assert.ok(!calls.includes("actions.invoke") && !calls.includes("forms.submit") && !calls.includes("sessions.send"));
  });

  test(`${kind}：进行中的同 key 并发请求只执行一次`, async t => {
    const { run, set, success } = setup(t);
    const gate = deferred(); let count = 0;
    set(() => { count++; return gate.promise; });
    const first = run();
    assert.equal((await run("key", false, otherOrigin)).status, "pending");
    assert.equal(count, 1);
    gate.resolve(success);
    assert.deepEqual(await first, success);
  });

  test(`${kind}：插件返回 pending 后，同一 key 可以继续查询`, async t => {
    const { run, set, success } = setup(t);
    let count = 0;
    set(async () => ++count === 1 ? { status: "pending" } : success);
    assert.equal((await run()).status, "pending");
    assert.deepEqual(await run("key", false, otherOrigin), success);
    assert.equal(count, 2);
    assert.deepEqual(await run(), success);
    assert.equal(count, 2);
  });

  for (const mode of ["同步抛错", "异步拒绝", "迟到拒绝"]) {
    test(`${kind}：${mode}被限制在事务内`, async t => {
      const { run, set } = setup(t);
      const gate = deferred(); let count = 0;
      set(() => {
        count++;
        if (mode === "同步抛错") throw new Error("内部细节");
        if (mode === "异步拒绝") return Promise.reject(new Error("内部细节"));
        return gate.promise;
      });
      if (mode === "迟到拒绝") {
        assert.equal((await run()).status, "pending");
        gate.reject(new Error("内部细节"));
        await delay(0);
      }
      const result = await run();
      assert.equal(result.status, kind === "send" ? "rejected" : "failed");
      assert.ok(!result.message.includes("内部细节"));
      assert.deepEqual(await run(), result);
      assert.equal(count, 1);
    });
  }
}

test("动作目录存在性、来源与 resolveForm 的调用边界", async t => {
  const { operations: ops, plugin, calls } = harness(t);
  let invokes = 0;
  plugin.actions.invoke = async () => { invokes++; return { status: "ok" }; };
  const resolved = await ops.resolveForm("p", "p.run", { type: "global" });
  assert.equal(resolved.id, "ephemeral");
  assert.deepEqual(ops.pending(), []);
  assert.equal(invokes, 0);
  assert.deepEqual(calls, ["actions.list", "actions.resolveForm"]);
  await assert.rejects(ops.invoke("p", invocation("missing", { actionId: "absent" }), origin), { code: "actionNotFound" });
  plugin.actions.list = () => [{ id: "p.run", source: "q", title: "执行", scope: ["global"] }];
  await assert.rejects(ops.invoke("p", invocation(), origin), { code: "invalidPlugin" });
  assert.equal(invokes, 0);
});

test("动作 timeoutMs 覆盖默认等待，最大等待为 60 秒", async t => {
  const { operations: ops, plugin } = harness(t, { timeoutMs: 1 });
  const gate = deferred();
  plugin.actions.list = () => [{ id: "p.run", source: "p", title: "执行", scope: ["global"], timeoutMs: 500 }];
  plugin.actions.invoke = () => gate.promise;
  const result = ops.invoke("p", invocation(), origin);
  await delay(15);
  gate.resolve({ status: "ok" });
  assert.equal((await result).status, "ok");
  const waits = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    waits.push(ms);
    return realTimeout(fn, ms, ...args);
  });
  const other = deferred();
  plugin.actions.list = () => [{ id: "p.run", source: "p", title: "执行", scope: ["global"], timeoutMs: 90_000 }];
  plugin.actions.invoke = () => other.promise;
  const long = ops.invoke("p", invocation("long"), origin);
  await delay(0);
  assert.deepEqual(waits, [60_000]);
  ops.close();
  assert.equal((await long).status, "pending");
  other.resolve({ status: "ok" });
});

test("同一来源的动作、表单和发送共享幂等命名空间，不同来源隔离", async t => {
  const { operations: ops, plugins, plugin } = harness(t);
  const q = { ...plugin, id: "q", sessions: { ...plugin.sessions } };
  plugins.set("q", q);
  await ops.invoke("p", invocation("shared"), origin);
  ops.formAdded("p", form());
  assert.equal((await ops.submit("p", submission("shared"), origin)).status, "idempotencyConflict");
  assert.equal((await ops.send("p", ref, input, sendReq("shared"))).status, "idempotencyConflict");
  assert.equal((await ops.send("q", { ...ref, source: "q" }, input, sendReq("shared"))).status, "accepted");
});

test("指纹忽略字段顺序、origin 和发送 expectedRevision，保留原始业务字段", async t => {
  const { operations: ops, plugin } = harness(t);
  let invokes = 0;
  plugin.actions.invoke = async () => { invokes++; return { status: "ok" }; };
  const first = invocation("ordered", { input: { answers: [], fields: { a: "甲", b: "乙" } } });
  await ops.invoke("p", first, origin);
  const reordered = { input: { fields: { b: "乙", a: "甲" }, answers: [] }, idempotencyKey: "ordered", actionId: "p.run" };
  assert.equal((await ops.invoke("p", { ...reordered, origin: otherOrigin, expectedRevision: 4 }, otherOrigin)).status, "ok");
  assert.equal(invokes, 1);
  assert.equal((await ops.invoke("p", { ...first, extra: "业务字段" }, origin)).status, "idempotencyConflict");
  let sends = 0;
  plugin.sessions.send = async () => { sends++; return { status: "accepted" }; };
  await ops.send("p", ref, input, sendReq());
  assert.equal((await ops.send("p", ref, input, sendReq("send-key", { origin: otherOrigin, expectedRevision: 999 }))).status, "accepted");
  assert.equal((await ops.send("p", { ...ref, id: "other" }, input, sendReq())).status, "idempotencyConflict");
  assert.equal(sends, 1);
});

test("业务输入、插件返回值、事件和 pending 列表使用独立副本，origin 保留原对象", async t => {
  const { operations: ops, plugin, events } = harness(t);
  const gate = deferred();
  const inv = invocation("clone", { input: { answers: [], fields: { field: "原值" } } });
  const who = { ...origin };
  let received;
  plugin.actions.invoke = (request, requestOrigin) => { received = { request, requestOrigin }; return gate.promise; };
  const pending = ops.invoke("p", inv, who);
  inv.input.fields.field = "外部修改";
  await delay(0);
  assert.equal(received.request.input.fields.field, "原值");
  assert.equal(received.requestOrigin, who);
  received.request.input.fields.field = "插件修改";
  const result = { status: "ok", message: "原结果" };
  gate.resolve(result);
  const first = await pending;
  result.message = "插件后续修改"; first.message = "调用方修改";
  assert.equal((await ops.invoke("p", invocation("clone", { input: { answers: [], fields: { field: "原值" } } }), origin)).message, "原结果");
  const f = form(); ops.formAdded("p", f); f.title = "外部修改";
  events.at(-1).form.title = "事件修改";
  ops.pending()[0].title = "列表修改";
  assert.equal(ops.pending()[0].title, "form");
});

test("动作、表单和发送的首次执行及 pending 查询均保留 broker origin 对象身份", async t => {
  const { operations: ops, plugin } = harness(t);
  const firstOrigin = Object.freeze({ ...origin }), nextOrigin = Object.freeze({ ...otherOrigin });
  const authenticated = new WeakMap([[firstOrigin, "first"], [nextOrigin, "next"]]);
  const seen = { action: [], form: [], send: [] };
  function result(kind, who) {
    assert.ok(authenticated.has(who));
    seen[kind].push(authenticated.get(who));
    return seen[kind].length === 1 ? { status: "pending" } : { status: kind === "action" ? "ok" : "accepted" };
  }
  plugin.actions.invoke = async (_inv, who) => result("action", who);
  plugin.forms.submit = async (_req, who) => result("form", who);
  plugin.sessions.send = async (_ref, _input, req) => result("send", req.origin);
  ops.formAdded("p", form());
  assert.equal((await ops.invoke("p", invocation(), firstOrigin)).status, "pending");
  assert.equal((await ops.invoke("p", invocation(), nextOrigin)).status, "ok");
  assert.equal((await ops.submit("p", submission(), firstOrigin)).status, "pending");
  assert.equal((await ops.submit("p", submission(), nextOrigin)).status, "accepted");
  assert.equal((await ops.send("p", ref, input, sendReq("send-key", { origin: firstOrigin }))).status, "pending");
  assert.equal((await ops.send("p", ref, input, sendReq("send-key", { origin: nextOrigin }))).status, "accepted");
  assert.deepEqual(seen, { action: ["first", "next"], form: ["first", "next"], send: ["first", "next"] });
});

test("默认等待为 10 秒，close 清理等待计时器", async t => {
  const waits = [], realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    waits.push(ms);
    return realTimeout(fn, ms, ...args);
  });
  const { operations: ops, plugin } = harness(t, { timeoutMs: undefined });
  const gate = deferred(); plugin.sessions.send = () => gate.promise;
  const sending = ops.send("p", ref, input, sendReq());
  assert.deepEqual(waits, [10_000]);
  ops.close();
  assert.equal((await sending).status, "pending");
  gate.resolve({ status: "accepted" });
});

test("双标签页同版本仅调用一次，未知结果和 returned pending 都保留表单与 claim", async t => {
  const { operations: ops, plugin } = harness(t);
  const gate = deferred(); let count = 0;
  plugin.forms.submit = () => { count++; return gate.promise; };
  ops.formAdded("p", form());
  const first = ops.submit("p", submission("a"), origin);
  assert.equal((await ops.submit("p", submission("b"), otherOrigin)).status, "alreadyHandled");
  assert.equal((await first).status, "pending");
  assert.equal((await ops.submit("p", submission("c"), otherOrigin)).status, "alreadyHandled");
  assert.equal(ops.pending().length, 1);
  assert.equal(count, 1);
  gate.resolve({ status: "pending" }); await delay(0);
  assert.equal((await ops.submit("p", submission("d"), otherOrigin)).status, "alreadyHandled");
  plugin.forms.submit = async () => { count++; return { status: "accepted" }; };
  assert.equal((await ops.submit("p", submission("a"), otherOrigin)).status, "accepted");
  assert.equal(ops.pending().length, 1);
  assert.equal((await ops.submit("p", submission("e"), otherOrigin)).status, "alreadyHandled");
  assert.equal(count, 2);
  ops.formRemoved("p", "form", "handled");
  assert.deepEqual(ops.pending(), []);
  assert.equal((await ops.submit("p", submission("a"), origin)).status, "accepted");
});

for (const status of ["failed", "stale", "idempotencyConflict"]) {
  test(`表单最终 ${status} 释放 claim，用户可以使用新 key 重试`, async t => {
    const { operations: ops, plugin } = harness(t);
    ops.formAdded("p", form());
    plugin.forms.submit = async () => status === "stale" ? { status, form: form("form", 2) } : { status, message: "请重试" };
    assert.equal((await ops.submit("p", submission("first"), origin)).status, status);
    plugin.forms.submit = async () => ({ status: "accepted" });
    assert.equal((await ops.submit("p", submission("retry", status === "stale" ? 2 : 1), origin)).status, "accepted");
    assert.equal((await ops.submit("p", submission("first"), origin)).status, status);
  });
}

test("权威空快照移除未知事务表单，保留幂等记录和 claim；迟到失败后允许重试", async t => {
  const { operations: ops, plugin, events } = harness(t);
  const gate = deferred(); let count = 0;
  ops.formAdded("p", form()); plugin.forms.submit = () => { count++; return gate.promise; };
  assert.equal((await ops.submit("p", submission("first"), origin)).status, "pending");
  await ops.align("p");
  assert.deepEqual(ops.pending(), []);
  assert.deepEqual(events.at(-1), { type: "formRemoved", source: "p", formId: "form", reason: "withdrawn" });
  assert.equal((await ops.submit("p", submission("first"), otherOrigin)).status, "pending");
  assert.equal(count, 1);
  ops.formAdded("p", form());
  assert.equal((await ops.submit("p", submission("blocked"), otherOrigin)).status, "alreadyHandled");
  gate.resolve({ status: "failed", message: "请重试" }); await delay(0);
  plugin.forms.submit = async () => ({ status: "accepted" });
  assert.equal((await ops.submit("p", submission("retry"), otherOrigin)).status, "accepted");
});

test("formRemoved 释放 claim，迟到 stale 结果不能复活已移除表单", async t => {
  const { operations: ops, plugin } = harness(t);
  const gate = deferred();
  ops.formAdded("p", form()); plugin.forms.submit = () => gate.promise;
  const submitting = ops.submit("p", submission(), origin);
  await delay(0);
  ops.formRemoved("p", "form", "withdrawn");
  gate.resolve({ status: "stale", form: form("form", 2) });
  assert.equal((await submitting).status, "stale");
  assert.deepEqual(ops.pending(), []);
  ops.formAdded("p", form()); plugin.forms.submit = async () => ({ status: "accepted" });
  assert.equal((await ops.submit("p", submission("retry"), origin)).status, "accepted");
});

test("表单提交异常同样释放 claim，落后和超前 revision 不进入插件", async t => {
  const { operations: ops, plugin } = harness(t);
  ops.formAdded("p", form("form", 2)); let count = 0;
  plugin.forms.submit = () => { count++; throw new Error("失败"); };
  assert.equal((await ops.submit("p", submission("old", 1), origin)).status, "stale");
  assert.equal((await ops.submit("p", submission("future", 3), origin)).status, "stale");
  assert.equal(count, 0);
  assert.equal((await ops.submit("p", submission("bad", 2), origin)).status, "failed");
  plugin.forms.submit = async () => { count++; return { status: "accepted" }; };
  assert.equal((await ops.submit("p", submission("retry", 2), origin)).status, "accepted");
  assert.equal(count, 2);
});

test("对齐按时间和 id 排序，期间添加、删除事件按顺序应用", async t => {
  const { operations: ops, plugin, events, calls } = harness(t);
  const gate = deferred();
  plugin.forms.pending = () => gate.promise;
  ops.formAdded("p", form("old"));
  const align = ops.align("p"), second = ops.align("p");
  ops.formAdded("p", form("a", 2, { title: "新版本", createdAt: "2026-07-01T00:00:00Z" }));
  ops.formRemoved("p", "removed", "handled");
  ops.formAdded("p", form("c"));
  gate.resolve([form("removed"), form("b"), form("a")]);
  await Promise.all([align, second]);
  assert.deepEqual(ops.pending().map(f => [f.id, f.revision]), [["a", 2], ["b", 1], ["c", 1]]);
  assert.equal(ops.pending()[0].createdAt, form().createdAt);
  assert.equal(calls.filter(method => method === "forms.pending").length, 1);
  assert.ok(events.some(e => e.type === "formRemoved" && e.source === "p" && e.formId === "old" && e.reason === "withdrawn"));
  assert.ok(events.some(e => e.type === "formRemoved" && e.source === "p" && e.formId === "removed" && e.reason === "handled"));
});

test("较低与相同 revision 被忽略，createdAt 保持初值，expiresAt 不触发本地删除", async t => {
  const { operations: ops, events } = harness(t);
  ops.formAdded("p", form("form", 2, { expiresAt: "2000-01-01T00:00:00Z" }));
  ops.formAdded("p", form("form", 1));
  ops.formAdded("p", form("form", 2, { title: "忽略" }));
  ops.formAdded("p", form("form", 3, { title: "更新", createdAt: "2027-01-01T00:00:00Z" }));
  assert.equal(events.length, 2);
  assert.equal(ops.pending()[0].title, "更新");
  assert.equal(ops.pending()[0].createdAt, form().createdAt);
});

test("对齐失败仍应用期间的事件，其他来源的同 id 表单与 claim 隔离", async t => {
  const { operations: ops, plugin, plugins, events } = harness(t);
  plugins.set("q", { ...plugin, id: "q" });
  ops.formAdded("p", form()); ops.formAdded("q", form("form", 1, { source: "q" }));
  const gate = deferred(); plugin.forms.pending = () => gate.promise;
  const aligning = ops.align("p");
  ops.formAdded("p", form("new")); ops.formRemoved("p", "form", "cancelled");
  gate.reject(new Error("读取失败"));
  await assert.rejects(aligning);
  assert.deepEqual(ops.pending("p").map(f => f.id), ["new"]);
  assert.equal(ops.pending("q").length, 1);
  assert.equal((await ops.submit("q", submission(), origin)).status, "accepted");
  assert.deepEqual(events.find(e => e.type === "formRemoved"), { type: "formRemoved", source: "p", formId: "form", reason: "cancelled" });
});

test("unavailable 清除表单且不取消后台事务，迟到快照不能复活表单", async t => {
  const { operations: ops, plugin, plugins, events } = harness(t);
  const submitGate = deferred(), alignGate = deferred();
  ops.formAdded("p", form());
  plugin.forms.submit = () => submitGate.promise;
  plugin.forms.pending = () => alignGate.promise;
  const submitting = ops.submit("p", submission(), origin);
  const aligning = ops.align("p");
  await delay(0);
  ops.formAdded("p", form("queued"));
  ops.unavailable("p"); plugins.delete("p");
  assert.deepEqual(ops.pending(), []);
  assert.ok(events.some(e => e.type === "formRemoved" && e.source === "p" && e.reason === "withdrawn"));
  alignGate.resolve([form()]); await aligning;
  ops.formAdded("p", form("late"));
  assert.deepEqual(ops.pending(), []);
  submitGate.resolve({ status: "accepted" });
  assert.equal((await submitting).status, "accepted");
  assert.equal((await ops.submit("p", submission(), origin)).status, "accepted");
  plugins.set("p", plugin); plugin.forms.pending = async () => [form("back")];
  await ops.align("p");
  assert.deepEqual(ops.pending().map(f => f.id), ["back"]);
});

test("最终结果至少保留 24 小时；迟到结果按完成时间保留，pending 不按时间清理", async t => {
  let now = 0;
  const { operations: ops, plugin } = harness(t, { now: () => now });
  let count = 0;
  plugin.sessions.send = async () => { count++; return { status: "accepted" }; };
  await ops.send("p", ref, input, sendReq("final"));
  now = 24 * 60 * 60 * 1000;
  await ops.send("p", ref, input, sendReq("final"));
  assert.equal(count, 1);
  now++;
  await ops.send("p", ref, input, sendReq("final"));
  assert.equal(count, 2);
  const gate = deferred();
  plugin.sessions.send = () => { count++; return gate.promise; };
  assert.equal((await ops.send("p", ref, input, sendReq("late"))).status, "pending");
  now += 3 * 24 * 60 * 60 * 1000;
  assert.equal((await ops.send("p", ref, input, sendReq("late"))).status, "pending");
  assert.equal(count, 3);
  gate.resolve({ status: "accepted" }); await delay(0);
  now += 24 * 60 * 60 * 1000;
  assert.equal((await ops.send("p", ref, input, sendReq("late"))).status, "accepted");
  assert.equal(count, 3);
});

test("未完成记录达到上限时拒绝新 key，保留已有 pending 查询", async t => {
  const { operations: ops, plugin } = harness(t);
  let count = 0;
  plugin.sessions.send = async () => { count++; return { status: "pending" }; };
  for (let i = 0; i < 1024; i++) await ops.send("p", ref, input, sendReq(`key-${i}`));
  await assert.rejects(ops.send("p", ref, input, sendReq("overflow")), { code: "tooManyOperations", status: 429 });
  plugin.sessions.send = async () => { count++; return { status: "accepted" }; };
  assert.equal((await ops.send("p", ref, input, sendReq("key-0"))).status, "accepted");
  assert.equal((await ops.send("p", ref, input, sendReq("overflow"))).status, "accepted");
  assert.equal(count, 1026);
});

test("校验非法请求与跨来源表单，非法插件结果归入事务失败", async t => {
  const { operations: ops, plugin } = harness(t);
  await assert.rejects(ops.send("p", { ...ref, source: "q" }, input, sendReq()), { code: "invalidRequest" });
  await assert.rejects(ops.send("p", ref, { text: 1 }, sendReq()), { code: "invalidRequest" });
  await assert.rejects(ops.submit("p", { ...submission(), revision: -1 }, origin), { code: "invalidRequest" });
  assert.throws(() => ops.formAdded("p", form("bad", 1, { source: "q" })), { code: "invalidRequest" });
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(ops.invoke("p", invocation("cycle", { input: cycle }), origin), { code: "invalidRequest" });
  plugin.actions.invoke = async () => ({ status: "needsInput", followUpForm: form("bad", 1, { source: "q" }) });
  assert.equal((await ops.invoke("p", invocation(), origin)).status, "failed");
  ops.formAdded("p", form());
  plugin.forms.submit = async () => ({ status: "stale", form: form("wrong-id", 2) });
  assert.equal((await ops.submit("p", submission(), origin)).status, "failed");
  plugin.sessions.send = async () => ({ status: "bogus" });
  assert.equal((await ops.send("p", ref, input, sendReq())).status, "rejected");
});

test("close 结束 HTTP 等待但继续观察后台拒绝，关闭后拒绝新请求", async t => {
  const { operations: ops, plugin, events } = harness(t, { timeoutMs: 60_000 });
  const gate = deferred(); plugin.sessions.send = () => gate.promise;
  const sending = ops.send("p", ref, input, sendReq());
  await delay(0);
  ops.close(); ops.close();
  assert.equal((await sending).status, "pending");
  gate.reject(new Error("关闭后的拒绝")); await delay(0);
  ops.formAdded("p", form());
  assert.equal(events.length, 0);
  assert.deepEqual(ops.pending(), []);
  await assert.rejects(ops.send("p", ref, input, sendReq("new")), { code: "closed" });
});
