// 插件操作对象（packages/web/src/lib/operation.ts）：首次响应和每次查询的结果交给同一个对象结算。
// 规则：只有确定送达（done）不放回；首次响应的其余结果都立即放回原文，只放一次；查询失败不结算原操作。
import test from "node:test";
import assert from "node:assert/strict";
import { Operation } from "../packages/web/src/lib/operation.ts";

/** 替身：steps 依次作为每次请求的结果（抛出 Error 表示请求本身抛错）；box 模拟输入框，restore 把原文放在当前内容之前。 */
function harness(steps, { text = "原文", box = "" } = {}) {
  const entries = new Map(); const toasts = []; const sent = [];
  const input = { value: box, restores: 0 };
  const host = {
    show: (entry) => entries.set(entry.key, entry),
    hide: (key) => entries.delete(key),
    toast: (message, level = "info") => toasts.push([level, message]),
  };
  const attempt = async (query) => {
    const step = steps[sent.length]; sent.push({ step, query });
    if (step instanceof Error) throw step;
    return typeof step === "string" ? { state: step } : step;
  };
  const op = new Operation({ key: "k1", source: "uitest", attempt, pendingText: "处理中", unknownText: "结果未知",
    text: { restore: () => { input.restores++; input.value = [text, input.value].filter(Boolean).join("\n"); } } }, host);
  /** 用户点查询入口：始终取界面上当前的入口。 */
  const query = () => { const entry = entries.get("k1"); assert.ok(entry, "应有查询入口"); return entry.query(); };
  return { op, entries, toasts, sent, input, query };
}

test("pending：立即放回原文（放在当前内容之前），留下查询入口；之后查到被拒只提示结果、不再放回，入口始终指向同一对象", async () => {
  const h = harness(["pending", "pending", { state: "notRun", message: "插件拒绝" }], { box: "期间新写的" });
  assert.equal(await h.op.run(), "pending");
  assert.equal(h.input.value, "原文\n期间新写的", "原文放在当前内容之前");
  assert.equal(h.entries.get("k1").state, "pending");
  assert.match(h.entries.get("k1").message, /^处理中，文字已放回输入框$/);
  const firstQuery = h.entries.get("k1").query;
  assert.equal(await h.query(), "pending");
  assert.equal(h.entries.get("k1").query, firstQuery, "查询入口不被替换");
  assert.equal(await h.query(), "notRun");
  assert.equal(h.input.restores, 1, "只放回一次");
  assert.equal(h.entries.size, 0);
  assert.deepEqual(h.toasts, [["error", "插件拒绝"]]);
  assert.deepEqual(h.sent.map((s) => s.query), [false, true, true], "首次请求与查询分开");
});

test("pending → 查询 accepted：结束，提示删去放回的文字", async () => {
  const h = harness(["pending", "done"]);
  await h.op.run();
  assert.equal(h.input.restores, 1);
  assert.equal(await h.query(), "done");
  assert.equal(h.input.restores, 1); assert.equal(h.entries.size, 0);
  assert.deepEqual(h.toasts, [["info", "已送达，请删去输入框里放回的文字"]]);
  assert.equal(await h.op.run(), "done", "结束后不再发请求"); assert.equal(h.sent.length, 2);
});

test("首次即 accepted：不放回、没有入口、没有删去提示", async () => {
  const h = harness([{ state: "done", message: "已留言" }]);
  assert.equal(await h.op.run(), "done");
  assert.equal(h.input.restores, 0); assert.equal(h.entries.size, 0); assert.deepEqual(h.toasts, [["info", "已留言"]]);
});

test("首发断网 → 查询 rejected：放回一次，被拒时不重复放回", async () => {
  const h = harness(["unknown", { state: "notRun", message: "被拒" }]);
  assert.equal(await h.op.run(), "unknown");
  assert.equal(h.input.value, "原文"); assert.match(h.entries.get("k1").message, /^结果未知，文字已放回输入框$/);
  assert.equal(await h.query(), "notRun");
  assert.equal(h.input.restores, 1); assert.equal(h.entries.size, 0);
});

test("首发断网 → 查询 accepted：提示删去放回的文字", async () => {
  const h = harness(["unknown", { state: "done", message: "已留言" }]);
  await h.op.run();
  assert.equal(await h.query(), "done");
  assert.equal(h.input.restores, 1); assert.equal(h.entries.size, 0);
  assert.deepEqual(h.toasts, [["info", "已留言"], ["info", "已送达，请删去输入框里放回的文字"]]);
});

test("查询失败（断网、请求被拒）只说明这次查询没有成功：不结算、入口与状态不变，之后仍可查到结果", async () => {
  const h = harness(["pending", { state: "unknown", message: "请求来源无效" }, "unknown", "pending", "done"]);
  await h.op.run();
  assert.equal(await h.query(), "unknown");
  assert.equal(h.entries.get("k1").state, "pending", "查询失败不改变入口的状态");
  assert.match(h.toasts.at(-1)[1], /这次查询没有成功（请求来源无效）/);
  assert.equal(await h.query(), "unknown");
  assert.equal(h.entries.size, 1); assert.equal(h.op.done, false);
  await h.query(); await h.query();
  assert.equal(h.input.restores, 1); assert.equal(h.entries.size, 0);
  assert.equal(h.toasts.at(-1)[1], "已送达，请删去输入框里放回的文字");
});

test("首次即确定没有执行：放回原文、没有入口；请求抛错按结果未知处理；连续查询共用进行中的一次", async () => {
  const a = harness([{ state: "notRun", message: "冲突" }]);
  assert.equal(await a.op.run(), "notRun"); assert.equal(a.input.value, "原文"); assert.equal(a.entries.size, 0);

  const b = harness([new Error("意外错误"), "done"]);
  assert.equal(await b.op.run(), "unknown"); assert.equal(b.input.restores, 1); assert.equal(b.entries.get("k1").state, "unknown");
  const [x, y] = await Promise.all([b.query(), b.query()]);
  assert.equal(x, "done"); assert.equal(y, "done"); assert.equal(b.sent.length, 2, "两次点击只发一次查询");
});

test("没有原文的操作（按钮动作）：pending 留下入口，提示里不写放回", async () => {
  const entries = new Map();
  const op = new Operation({ key: "k2", source: "uitest", attempt: async () => ({ state: "pending" }), pendingText: "处理中", unknownText: "结果未知" },
    { show: (e) => entries.set(e.key, e), hide: (k) => entries.delete(k), toast: () => {} });
  await op.run();
  assert.equal(entries.get("k2").message, "处理中");
});
