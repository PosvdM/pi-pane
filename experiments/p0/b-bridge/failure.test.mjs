import assert from 'node:assert/strict';
import test from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExperiment } from '../harness/index.mjs';
import { startBridge } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('pane #9：ticket 已兑换时 bridge 不就绪，任务书未发出，停止自己的 pi', async t => {
  const e = await createExperiment();
  const bridge = await startBridge(join(e.root, 'server.jsonl'));
  t.diagnostic(`fixture: ${e.root}`);
  t.after(async () => {
    await e.stop(); await bridge.close();
    if (t.passed && process.env.B_KEEP !== '1') await e.cleanup();
  });
  assert.equal((await fetch(bridge.url + '/bridge/launch', { method: 'POST', body: JSON.stringify({ ticket: bridge.ticket }) })).status, 200);
  let failure;
  await assert.rejects(async () => {
    try { await e.start({ args: ['-e', join(here, 'bridge.ts')], env: { B_URL: bridge.url, B_LOG: join(e.root, 'bridge.jsonl'), PANE_BRIDGE_TICKET: bridge.ticket } }); }
    catch (error) { failure = error; throw error; }
  }, /bridge ticket rejected/);
  assert.match(failure.message, /"code":1/);
  const gate = await bridge.submit({ command() { throw new Error('must not send'); } }, { type: 'prompt', message: 'THIS_MUST_NOT_REACH_PROVIDER' });
  assert.equal(gate.error, 'bridge_not_ready');
  assert.equal((await e.requests()).length, 0);
  assert.equal(bridge.records.filter(r => r.path === '/bridge/launch').at(-1).status, 403);
  await e.stop();
  t.diagnostic(JSON.stringify({ observation: 'ticket-rejected', launches: bridge.records.filter(r => r.path === '/bridge/launch').map(r => r.status), providerRequests: 0, ready: bridge.ready, startupExitCode: 1 }));
});
