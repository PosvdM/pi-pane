import test from "node:test";
import assert from "node:assert/strict";
import { Inflight } from "../packages/server/dist/inflight.js";
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test("门禁与登记同步完成，成功、异步拒绝及同步抛错都结束登记", async () => {
  const inflight = new Inflight(); const gate = deferred(); let entered = false;
  const operation = inflight.run("open", async () => { entered = true; await gate.promise; });
  assert.equal(entered, true); inflight.seal();
  let called = false; await assert.rejects(inflight.run("late", () => { called = true; }), { code: "serverStopping" }); assert.equal(called, false);
  let drained = false; const draining = inflight.drain().then(() => { drained = true; });
  await new Promise(setImmediate); assert.equal(drained, false); gate.resolve(); await operation; await draining;
  const failures = new Inflight(); const error = new Error("拒绝");
  await assert.rejects(failures.run("sync", () => { throw error; }), e => e === error);
  await assert.rejects(failures.run("async", async () => { throw error; }), e => e === error);
  failures.seal(); await failures.drain();
});

test("资源 owner 允许关闭后的内部收尾，排空覆盖迟到子操作而非单次快照", async () => {
  const inflight = new Inflight(); const owner = inflight.owner("writer"); const gate = deferred(); const entered = deferred(); const cleanup = deferred();
  inflight.seal(); let drained = false; const draining = inflight.drain().then(() => { drained = true; });
  await new Promise(setImmediate); assert.equal(drained, false);
  const ending = owner.run("stop", async () => { await gate.promise; const child = owner.run("late-release", async () => { entered.resolve(); await cleanup.promise; }); owner.close(); return child; });
  gate.resolve(); await entered.promise; await new Promise(setImmediate); assert.equal(drained, false);
  await assert.rejects(owner.run("after-close", () => assert.fail()), { code: "serverStopping" });
  cleanup.resolve(); await ending; await draining; assert.equal(drained, true);
  assert.throws(() => inflight.owner("new-writer"), { code: "serverStopping" });
});

test("终止阶段要求门禁及完整排空，释放拒绝不能变成排空失败或遗留登记", async () => {
  const inflight = new Inflight(); const owner = inflight.owner("writer");
  await assert.rejects(inflight.finalize("release", () => assert.fail()), /尚未排空/);
  inflight.seal(); await assert.rejects(inflight.finalize("release", () => assert.fail()), /尚未排空/);
  owner.close(); await inflight.drain(); const failure = new Error("释放拒绝");
  await assert.rejects(inflight.finalize("release", async () => { throw failure; }), e => e === failure); await inflight.drain();
});
