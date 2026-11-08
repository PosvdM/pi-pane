import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { sessionLocksDir } from "pi-hostkit";
import { piFixture } from "./fixtures/helpers.mjs";
import { startServer } from "./fixtures/client.mjs";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
// 原生导出不可写；在首次加载前包装加载器，仍执行真实取锁及释放，只在指定释放完成后注入拒绝。
const require = createRequire(import.meta.url);
const loaderPath = require.resolve("node-gyp-build"); const load = require(loaderPath);
let onAcquire; let onRelease;
require.cache[loaderPath].exports = directory => {
  const binding = load(directory);
  return Object.fromEntries(Object.getOwnPropertyNames(binding).map(name => [name,
    ["mutexAcquire", "flockAcquire"].includes(name) ? (...args) => { const result = binding[name](...args); onAcquire?.(args[0], result); return result; }
      : ["mutexRelease", "fdClose"].includes(name) ? (...args) => { const result = binding[name](...args); onRelease?.(args[0]); return result; } : binding[name]]));
};

for (const fault of [true, false]) test(`关闭等待真实 probe 准备及释放${fault ? "，保留迟到释放拒绝" : "，健康并发正常关闭"}`, { timeout: 30000 }, async t => {
  const f = await piFixture(); const server = await startServer(f); const entered = deferred(); const gate = deferred();
  const failure = new Error("注入 probe 原生释放拒绝"); const acquired = new Set(); let releasedProbe = 0; let releasedInstance = false;
  let opening; let closing;
  try {
    const mkdir = fs.mkdir;
    t.mock.method(fs, "mkdir", async (directory, ...args) => {
      if (path.resolve(directory) === path.resolve(sessionLocksDir())) { entered.resolve(); await gate.promise; }
      return mkdir(directory, ...args);
    }); syncBuiltinESMExports();
    onAcquire = (key, handle) => { if (String(key).includes("session-") && handle !== -1) acquired.add(handle); };
    onRelease = handle => { if (acquired.has(handle)) { releasedProbe++; if (fault) throw failure; } };
    const release = server.lock.release.bind(server.lock);
    server.lock.release = async () => { releasedInstance = true; await release(); };
    opening = server.sessions.open({ cwd: f.cwd }).catch(error => error); await entered.promise;
    assert.equal(acquired.size, 0, "gate 位于真实原生取锁之前");
    let finished = false; closing = server.close(); closing.then(() => { finished = true; }, () => { finished = true; });
    // 用事件循环轮转观察关闭是否错误完成，不用墙钟延迟决定竞态。
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);
    assert.equal(finished, false, "在途 probe 未收尾时，close 必须等待");
    assert.equal(releasedInstance, false);
    gate.resolve(); const result = await opening;
    assert.equal(acquired.size, 1); assert.equal(releasedProbe, 1, "真实原生释放路径必须执行");
    if (fault) {
      assert.equal(result, failure);
      await assert.rejects(closing, AggregateError); await assert.rejects(server.close(), AggregateError);
      assert.equal(releasedInstance, false, "probe 清理未确认时保留实例锁");
    } else {
      assert.equal(result.code, "serverStopping"); await closing; await server.close(); assert.equal(releasedInstance, true);
    }
  } finally {
    gate.resolve(); await opening; await closing?.catch(() => {});
    onAcquire = undefined; onRelease = undefined; t.mock.restoreAll(); syncBuiltinESMExports();
    await server.close().catch(() => {}); await server.lock.release(); await f.cleanup();
  }
});

test("关闭门禁拒绝新的 open，且不进入 probe 或原生锁", { timeout: 30000 }, async t => {
  const f = await piFixture(); const server = await startServer(f); let prepared = 0; let locks = 0;
  try {
    const mkdir = fs.mkdir;
    t.mock.method(fs, "mkdir", async (directory, ...args) => { if (path.resolve(directory) === path.resolve(sessionLocksDir())) prepared++; return mkdir(directory, ...args); });
    syncBuiltinESMExports(); onAcquire = () => { locks++; };
    const closing = server.close();
    await assert.rejects(server.sessions.open({ cwd: f.cwd }), { code: "serverStopping", status: 503 });
    await closing; assert.equal(prepared, 0); assert.equal(locks, 0);
  } finally { onAcquire = undefined; t.mock.restoreAll(); syncBuiltinESMExports(); await server.close(); await f.cleanup(); }
});
