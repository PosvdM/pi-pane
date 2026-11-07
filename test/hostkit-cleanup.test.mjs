import test from "node:test";
import assert from "node:assert/strict";
import { carriesUnconfirmedCleanup, observeHostkit, observeHostkitSync } from "../packages/server/dist/hostkit-cleanup.js";

const report = (steps = []) => ({ coverage: "snapshot_visible", steps, leftovers: [] });

test("hostkit 清理事实沿 cause/errors 保留，包括完整报告附带的查询拒绝", () => {
  for (const result of [report(), report([{ step: "snapshot", ok: false }]), { ...report(), leftovers: [{ pid: 123 }] }]) {
    const original = new Error("恢复查询失败", { cause: Object.freeze(result) });
    assert.equal(carriesUnconfirmedCleanup(new AggregateError([new AggregateError([original])])), true);
  }
  assert.equal(carriesUnconfirmedCleanup(new AggregateError([new Error("启动失败"), new Error("原生句柄关闭失败")], "无专用错误码")), true);
});

test("固定 hostkit 的无报告清理错误和循环上下文可判定", () => {
  for (const message of ["Cannot stop failed session writer", "Cannot release failed session lock", "Cannot release failed session acquisition",
    "Cannot release failed session probe", "Cannot clean up lock record file.tmp", "Cannot recover session writers",
    "stop after release failure: query failed", "release: writer exit cannot be confirmed", "启动回收未能确认退出", "恢复查询失败，清理结果见 cause"]) {
    assert.equal(carriesUnconfirmedCleanup(new Error(message)), true, message);
  }
  const cycle = new Error("普通查询失败"); cycle.cause = cycle;
  assert.equal(carriesUnconfirmedCleanup(cycle), false);
  cycle.errors = [cycle, new Error("Cannot stop failed session writer")];
  assert.equal(carriesUnconfirmedCleanup(cycle), true);
});

test("普通未启动、参数、业务拒绝及空错误上下文不产生清理失败", () => {
  for (const error of [null, undefined, "spawn rejected", new Error("ENOENT"), Object.assign(new Error("pi exited during start"), { code: "EHOSTKIT_SPAWN" }),
    Object.assign(new Error("spawnWriter: lock is acquired"), { code: "EHOSTKIT_LOCK_STATE" }), new AggregateError([]), new AggregateError([new Error("普通失败")]),
    new Error("普通失败", { cause: { coverage: "snapshot_visible", steps: [] } })]) assert.equal(carriesUnconfirmedCleanup(error), false);
});

test("hostkit 观察器在其他清理之前登记，原样抛出且不影响正常返回", async () => {
  const failure = new Error("启动失败", { cause: report() }); const seen = [];
  await assert.rejects(observeHostkit(async () => { throw failure; }, error => seen.push(error)), error => error === failure);
  assert.deepEqual(seen, [failure]);
  assert.throws(() => observeHostkitSync(() => { throw failure; }, error => seen.push(error)), error => error === failure);
  assert.deepEqual(seen, [failure, failure]);
  assert.equal(await observeHostkit(async () => 7, error => seen.push(error)), 7);
  assert.equal(observeHostkitSync(() => 8, error => seen.push(error)), 8);
  const ordinary = new Error("未启动");
  await assert.rejects(observeHostkit(async () => { throw ordinary; }, error => seen.push(error)), error => error === ordinary);
  assert.equal(seen.length, 2);
  await assert.rejects(observeHostkit(async () => { throw ordinary; }, error => seen.push(error), true), error => error === ordinary);
  assert.equal(seen[2], ordinary, "释放及临时持锁 probe 的所有拒绝都保留");
});
