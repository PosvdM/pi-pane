import test from "node:test";
import assert from "node:assert/strict";
import { RequestLedger, ControlQueue } from "../packages/server/dist/control.js";
const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test("pending 准入有上限，停止保留独立额度，已有幂等记录不删除", async () => {
  const ledger = new RequestLedger(Date.now, 5, 1, 1); const wait = deferred(); let calls = 0;
  assert.deepEqual(await ledger.execute("first", {}, () => { calls++; return wait.promise; }), { status: "pending" });
  assert.throws(() => ledger.execute("overflow", {}, async () => {}), code("pendingLimit"));
  assert.deepEqual(await ledger.execute("first", {}, async () => { calls++; }), { status: "pending" });
  assert.throws(() => ledger.execute("first", { changed: true }, async () => {}), code("idempotencyConflict"));
  const stop = deferred(); assert.deepEqual(await ledger.execute("stop", {}, () => stop.promise, true), { status: "pending" });
  assert.throws(() => ledger.execute("stop-overflow", {}, async () => {}, true), code("pendingLimit"));
  wait.resolve("confirmed"); stop.resolve("stopped"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await ledger.execute("first", {}, async () => { calls++; }), "confirmed"); assert.equal(calls, 1);
  assert.equal(await ledger.execute("overflow", {}, async () => "retry"), "retry");
});

test("控制队列限制排队，停止抢占并取消未执行项，活动项保留真实结局", async () => {
  const queue = new ControlQueue(1); const wait = deferred(); let activeSignal; let queuedCalls = 0;
  const active = queue.run(async signal => { activeSignal = signal; return wait.promise; });
  const queued = queue.run(async () => { queuedCalls++; });
  const rejected = assert.rejects(queued, code("controlPreempted"));
  assert.throws(() => queue.run(async () => {}), code("controlQueueLimit"));
  const stop = deferred();
  const priority = queue.run(async () => { assert.equal(queue.preempt(), true); await stop.promise; }, true);
  assert.throws(() => queue.run(async () => {}), code("controlStopping"));
  assert.throws(() => queue.run(async () => {}, true), code("controlStopping"));
  await rejected; assert.equal(activeSignal.aborted, true); assert.equal(queuedCalls, 0);
  wait.resolve("late confirmed result"); assert.equal(await active, "late confirmed result");
  stop.resolve(); await priority;
  assert.equal(await queue.run(async () => "after stop"), "after stop");
});
