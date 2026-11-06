import assert from 'node:assert/strict';
import test from 'node:test';
import { guardStop } from './experiment.mjs';

test('本地 stop 包装：已退出的 child 不调用发信号路径', async () => {
  for (const status of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
    let calls = 0;
    const driver = guardStop({ child: status, exit: Promise.resolve(status), stop() { calls++; } });
    await Promise.all([driver.stop(), driver.stop()]);
    assert.equal(calls, 0);
  }
});

test('本地 stop 包装：并发和重复停止只执行一次', async () => {
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const driver = guardStop({
    child: { exitCode: null, signalCode: null }, exit: blocked,
    async stop() { calls++; await blocked; },
  });
  const first = driver.stop();
  const second = driver.stop();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await first;
  await driver.stop();
  assert.equal(calls, 1);
});
