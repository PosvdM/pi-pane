import assert from 'node:assert/strict';
import test from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExperiment, readJsonl } from '../harness/index.mjs';
import { startBridge } from './server.mjs';
import { encode, images } from './images.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('图片 8：只替换 user，assistant 和真实 read 工具结果中的标记保持原样', async t => {
  const marker = 'ASSISTANT_TOOL_TEXT⟦pane-img:abc123:1⟧';
  const e = await createExperiment({ script: { turns: [
    { segments: [{ type: 'text', text: marker }, { type: 'toolCall', name: 'read', arguments: { path: 'marker.txt' } }] },
    { segments: [{ type: 'text', text: marker }] },
  ] } });
  await e.write('marker.txt', marker);
  const logPath = join(e.root, 'bridge.jsonl');
  const bridge = await startBridge(join(e.root, 'server.jsonl'));
  let rpc;
  t.diagnostic(`fixture: ${e.root}`);
  t.after(async () => {
    await e.stop(); await bridge.close();
    t.diagnostic(JSON.stringify({ observation: 'scope-cleanup', piPid: rpc?.child.pid, exit: rpc?.exitInfo }));
    if (t.passed && process.env.B_KEEP !== '1') await e.cleanup();
  });
  rpc = await e.start({ args: ['-e', join(here, 'bridge.ts')], env: { B_URL: bridge.url, B_LOG: logPath, PANE_BRIDGE_TICKET: bridge.ticket } });
  await bridge.waitReady();
  const sent = encode(images);
  await rpc.promptAndWait(sent.message, { images });
  const ended = rpc.events.filter(r => r.event.type === 'message_end').map(r => r.event.message);
  const assistant = ended.filter(m => m.role === 'assistant');
  assert.equal(assistant.length, 2);
  assert.ok(assistant.every(m => m.content.find(b => b.type === 'text').text === marker));
  assert.ok(ended.find(m => m.role === 'toolResult').content.some(b => b.text?.includes(marker)));
  assert.equal((await readJsonl(logPath)).filter(r => r.kind === 'restore').length, 1);
  assert.ok(!rpc.events.some(r => r.event.type === 'extension_ui_request' && r.event.message === '图片顺序未还原'));
  t.diagnostic(JSON.stringify({ observation: 'replacement-scope', userReplacements: 1, unchangedAssistantMessages: 2, unchangedToolResults: 1, warnings: 0 }));
});
