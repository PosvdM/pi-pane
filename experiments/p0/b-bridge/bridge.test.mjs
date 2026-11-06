import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createExperiment, readJsonl } from './experiment.mjs';
import { startBridge } from './server.mjs';
import { images, image, encode, restore, signature, validateImages } from './images.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const textReply = { segments: [{ type: 'text', text: 'LOCAL_SCRIPT_REPLY' }] };
const observation = (t, name, value) => t.diagnostic(JSON.stringify({ observation: name, ...value }));

async function fixture(t, options = {}) {
  const e = await createExperiment({ script: { fallback: textReply }, ...options });
  t.diagnostic(`fixture: ${e.root}`);
  const logPath = join(e.root, 'bridge.jsonl');
  const bridge = await startBridge(join(e.root, 'server.jsonl'));
  let rpc;
  let keep = false;
  t.after(async () => {
    await e.stop();
    await bridge.close();
    observation(t, 'cleanup', { piPid: rpc?.child.pid, exit: rpc?.exitInfo, retained: keep || !t.passed || process.env.B_KEEP === '1' });
    if (t.passed && !keep && process.env.B_KEEP !== '1') await e.cleanup();
  });
  const start = async (overrides = {}) => {
    rpc = await e.start({ ...overrides, args: ['-e', join(here, 'bridge.ts'), '-e', join(here, 'peer.ts'), ...(overrides.args ?? [])], env: { B_LOG: logPath, B_URL: bridge.url, PANE_BRIDGE_TICKET: bridge.ticket, ...(overrides.env ?? {}) } });
    await bridge.waitReady();
    return rpc;
  };
  return { e, bridge, start, retain: () => { keep = true; }, logs: () => readJsonl(logPath), logPath };
}
const userMessages = request => request.context.messages.filter(m => m.role === 'user');
async function assertRestored(e, rpc, sent, requestIndex = -1) {
  const reqs = await e.requests();
  const user = userMessages(reqs.at(requestIndex)).at(-1);
  const raw = { role: 'user', timestamp: user.timestamp, content: [{ type: 'text', text: sent.message }, ...sent.images] };
  const expected = restore(raw).message;
  assert.ok(expected);
  assert.deepEqual(user.content, expected.content);
  const entries = (await rpc.command({ type: 'get_entries' })).data.entries;
  assert.deepEqual(entries.findLast(entry => entry.message?.role === 'user').message.content, expected.content);
  const state = (await rpc.command({ type: 'get_state' })).data;
  const disk = await readJsonl(state.sessionFile);
  assert.deepEqual(disk.findLast(entry => entry.message?.role === 'user').message.content, expected.content);
  const ended = rpc.events.findLast(r => r.event.type === 'message_end' && r.event.message.role === 'user').event.message;
  const started = rpc.events.findLast(r => r.event.type === 'message_start' && r.event.message.role === 'user').event.message;
  assert.equal(ended.role, started.role);
  assert.equal(ended.timestamp, started.timestamp);
  assert.equal(ended.timestamp, user.timestamp);
  assert.deepEqual(ended.content, expected.content);
  return user;
}

for (const route of ['prompt', 'steer', 'follow_up']) {
  test(`图片 1/2/3/8：${route} 交错三图，重复三次`, async t => {
    const f = await fixture(t);
    const rpc = await f.start({ env: { B_SYNC: '1' } });
    for (let n = 0; n < 3; n++) {
      const sent = encode(images, ['红方块', '蓝圆', '字母C', '结束'], `order${n}`);
      const from = rpc.cursor;
      const requestCount = (await f.e.requests()).length;
      const restoreGate = f.bridge.armBarrier(`restore:order${n}`);
      const busyMessage = `busy:${route}:${n}`;
      const busyGate = route === 'prompt' ? undefined : f.bridge.armBarrier(`provider:${busyMessage}`);
      try {
        if (busyGate) {
          assert.equal((await rpc.command({ type: 'prompt', message: busyMessage })).success, true);
          await busyGate.waitEntered();
          assert.equal(busyGate.released, false);
          assert.equal((await rpc.command({ type: 'get_state' })).data.isStreaming, true);
          assert.equal((await rpc.command({ type: route, ...sent })).success, true);
          await rpc.waitFor(event => event.type === 'queue_update' && JSON.stringify(event).includes(sent.message), { from });
          assert.equal(busyGate.released, false);
          busyGate.release();
        } else assert.equal((await rpc.command({ type: 'prompt', ...sent })).success, true);
        await restoreGate.waitEntered();
        assert.equal(restoreGate.released, false);
        assert.equal((await f.e.requests()).length, requestCount + (busyGate ? 1 : 0));
        restoreGate.release();
        await rpc.waitFor('agent_settled', { from });
      } finally {
        busyGate?.release();
        restoreGate.release();
      }
      const user = await assertRestored(f.e, rpc, sent);
      const queue = rpc.events.slice(from).filter(r => r.event.type === 'queue_update');
      if (route !== 'prompt') {
        assert.equal(queue.length, 2);
        assert.match(JSON.stringify(queue[0]), /pane-img/);
        assert.doesNotMatch(JSON.stringify(queue.at(-1)), /pane-img/);
      }
      const logs = await f.logs();
      const restored = logs.findLast(r => r.kind === 'restore');
      const req = (await f.e.requests()).at(-1);
      assert.ok(Date.parse(req.timestamp) >= restored.at);
      observation(t, route, { repetition: n + 1, content: signature(user.content), restoreAt: restored.at, providerAt: Date.parse(req.timestamp), queueUpdates: queue.length, busyBarrier: Boolean(busyGate), restoreBarrier: true });
    }
  });
}

test('图片 4：恢复后的 provider 上下文保留交错图片，重复三次', async t => {
  for (let n = 0; n < 3; n++) {
    const f = await fixture(t);
    let rpc = await f.start();
    const sent = encode();
    await rpc.promptAndWait(sent.message, { images: sent.images });
    const original = await assertRestored(f.e, rpc, sent);
    const path = (await rpc.command({ type: 'get_state' })).data.sessionFile;
    await f.e.stop();
    // 新进程使用新 ticket；恢复不复用已经兑换的进程身份。
    const restart = await startBridge(join(f.e.root, 'restart-server.jsonl'));
    t.after(() => restart.close());
    rpc = await f.e.start({ args: ['--session', path, '-e', join(here, 'bridge.ts')], env: { B_LOG: f.logPath, B_URL: restart.url, PANE_BRIDGE_TICKET: restart.ticket } });
    await restart.waitReady();
    await rpc.promptAndWait('引用之前的 Image #2');
    assert.deepEqual(userMessages((await f.e.requests()).at(-1))[0].content, original.content);
    observation(t, 'resume', { repetition: n + 1, preserved: signature(original.content) });
    await f.e.stop();
  }
});

test('图片 5：export_html 的数据与实际用户渲染分支，重复三次', async t => {
  const f = await fixture(t);
  f.retain();
  const rpc = await f.start();
  for (let n = 0; n < 3; n++) {
    const sent = encode();
    await rpc.promptAndWait(sent.message, { images: sent.images });
    const response = await rpc.command({ type: 'export_html', outputPath: join(f.e.root, `export-${n}.html`) });
    assert.equal(response.success, true);
    const html = await readFile(response.data.path, 'utf8');
    const base64 = html.match(/<script[^>]*id="session-data"[^>]*>([\s\S]*?)<\/script>/)[1].trim();
    const data = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    const entry = data.entries.findLast(e => e.message?.role === 'user');
    assert.deepEqual(entry.message.content, restore({ role: 'user', content: [{ type: 'text', text: sent.message }, ...sent.images] }).message.content);
    // 运行导出 HTML 内的原始 user 分支；仅 stub 时间和 Markdown，未重写排列逻辑。
    const source = html.slice(html.indexOf('function renderEntry(entry)'));
    const userBranch = source.slice(0, source.indexOf("if (msg.role === 'assistant')"));
    const render = vm.runInNewContext(`(${userBranch}\n} return ''; })`, {
      formatTimestamp: () => '', renderCopyLinkButton: () => '', escapeHtml: s => s,
      parseSkillBlock: () => null, safeMarkedParse: s => s,
    });
    const output = render(entry);
    assert.ok(output.indexOf('<img ') < output.indexOf('段1'));
    assert.ok(output.indexOf(images[2].data) < output.indexOf('段1'));
    await writeFile(join(f.e.root, `render-${n}.html`), output);
    if (process.env.P0_RECORD === '1' && n === 0) await writeFile(join(here, 'export-order.html'), output);
    observation(t, 'export', { repetition: n + 1, embedded: signature(entry.message.content), rendered: 'I1,I2,I3,T1+T2+T3+tail', firstImageOffset: output.indexOf('<img '), firstTextOffset: output.indexOf('段1'), designPass: false });
  }
});

test('图片 6：手动和自动压缩后可以继续，重复三次', async t => {
  for (const automatic of [false, true]) for (let n = 0; n < 3; n++) {
    const f = await fixture(t, { settings: { compaction: { enabled: automatic, reserveTokens: 16384, keepRecentTokens: 20 } } });
    const rpc = await f.start();
    const sent = encode();
    await rpc.promptAndWait(sent.message, { images: sent.images });
    await rpc.promptAndWait('保留近期文字 '.repeat(250));
    if (automatic) {
      const next = (await f.e.requests()).length + 1;
      await f.e.setScript({ routes: [{ when: { request: next }, reply: { ...textReply, usage: { input: 195000, output: 10 } } }], fallback: textReply });
      const from = rpc.cursor;
      await rpc.promptAndWait('触发阈值压缩');
      const end = await rpc.waitFor('compaction_end', { from });
      assert.equal(end.aborted, false);
      assert.ok(end.result);
    } else {
      const response = await rpc.command({ type: 'compact' });
      assert.equal(response.success, true, JSON.stringify(response));
    }
    await rpc.promptAndWait('压缩之后继续');
    const entries = (await rpc.command({ type: 'get_entries' })).data.entries;
    assert.ok(entries.some(e => e.type === 'compaction'));
    assert.ok(entries.some(e => e.message?.role === 'user' && e.message.content.some(b => b.type === 'image')));
    observation(t, 'compact', { automatic, repetition: n + 1, compactions: entries.filter(e => e.type === 'compaction').length, requests: (await f.e.requests()).length });
  }
});

test('图片 9/10/11：自动缩放、相邻、纯图片、10 图、相似文字和备用编码，各重复三次', async t => {
  const f = await fixture(t, { settings: { images: { autoResize: true } } });
  const rpc = await f.start();
  for (let n = 0; n < 3; n++) {
    for (const [name, sent] of [
      ['only-images', encode(images, ['', '', '', ''])],
      ['adjacent', encode(images.slice(0, 2), ['开头', '', '末尾'])],
      ['ten-images', encode(Array.from({ length: 10 }, (_, i) => images[i % 3]))],
      ['similar-text', encode(images, ['手写[Image #1]和⟦pane-img:short:1⟧', '', '', ''])],
    ]) {
      await rpc.promptAndWait(sent.message, { images: sent.images });
      await assertRestored(f.e, rpc, sent);
      observation(t, name, { repetition: n + 1, imageCount: sent.images.length });
    }
    const large = encode([image(0, 2100, 24), image(1, 24, 2100)]);
    await rpc.command({ type: 'prompt', message: '/b-resize ' + JSON.stringify(large.images) });
    await rpc.promptAndWait(large.message, { images: large.images });
    const user = userMessages((await f.e.requests()).at(-1)).at(-1);
    assert.deepEqual(user.content.map(b => b.type), ['text', 'image', 'text', 'image', 'text']);
    const actual = user.content.filter(b => b.type === 'image');
    assert.notEqual(actual[0].data, large.images[0].data);
    assert.notEqual(actual[1].data, large.images[1].data);
    const reference = (await f.logs()).findLast(r => r.kind === 'resize-reference').hashes;
    assert.deepEqual(actual.map(img => ({ hash: createHash('sha256').update(img.data).digest('hex'), mimeType: img.mimeType })), reference.map(({ hash, mimeType }) => ({ hash, mimeType })));
    observation(t, 'auto-resize', { repetition: n + 1, dimensions: reference.map(r => r.dimensions), mimeTypes: actual.map(img => img.mimeType), referenceHashOrderMatches: true, types: user.content.map(b => b.type) });
    const fallback = { message: '红方块[Image #1]蓝圆[Image #2]白底C[Image #3]', images };
    await rpc.promptAndWait(fallback.message, { images });
    const tail = userMessages((await f.e.requests()).at(-1)).at(-1);
    assert.deepEqual(tail.content.map(b => b.type), ['text', 'image', 'image', 'image']);
    assert.deepEqual(tail.content.slice(1), images);
    observation(t, 'fallback', { repetition: n + 1, content: signature(tail.content), semanticModelCheck: 'skipped' });
  }
});

test('图片 10：无效 nonce/数量/编号只告警，不替换', async t => {
  const f = await fixture(t);
  const rpc = await f.start();
  for (let repeat = 0; repeat < 3; repeat++) for (const [message, count] of [
    ['x⟦pane-img:abc123:1⟧y⟦pane-img:other1:2⟧', 2],
    ['⟦pane-img:abc123:2⟧', 1],
    ['⟦pane-img:abc123:1⟧⟦pane-img:abc123:1⟧', 2],
    ['⟦pane-img:abc123:1⟧⟦pane-img:abc123:2⟧', 1],
  ]) {
    const from = rpc.cursor;
    await rpc.promptAndWait(message, { images: images.slice(0, count) });
    assert.equal(userMessages((await f.e.requests()).at(-1)).at(-1).content[0].text, message);
    assert.ok(rpc.events.slice(from).some(r => r.event.type === 'extension_ui_request' && /图片顺序未还原/.test(r.event.message)));
  }
});

test('图片 12/13：12 MiB 合法负载、JSONL 和 get_entries；三类超限不转发', async t => {
  const f = await fixture(t);
  const rpc = await f.start();
  const MiB = 1024 * 1024;
  const small = images[0];
  const smallBytes = Buffer.from(small.data, 'base64').length;
  const sizes = [4 * MiB - 1024, 4 * MiB - 1024, 4 * MiB + 2048 - smallBytes * 7];
  // 三张不超过 4 MiB，余量分给前两张，使总量恰好 12 MiB。
  sizes[0] += 2048; sizes[2] -= 2048;
  if (sizes[0] > 4 * MiB) { sizes[1] += sizes[0] - 4 * MiB; sizes[0] = 4 * MiB; }
  const imgs = [...sizes.map((size, i) => image(i, 24, 24, size)), ...Array(7).fill(small)];
  assert.equal(imgs.reduce((n, img) => n + Buffer.from(img.data, 'base64').length, 0), 12 * MiB);
  assert.equal(validateImages(imgs), undefined);
  const sent = encode(imgs);
  for (let repetition = 1; repetition <= 3; repetition++) {
    const before = process.memoryUsage();
    let sampledPeakRss = before.rss;
    const sampler = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, 10);
    t.after(() => clearInterval(sampler));
    const begin = performance.now();
    await rpc.promptAndWait(sent.message, { images: imgs });
    const sendMs = performance.now() - begin;
    const start = performance.now();
    const entries = (await rpc.command({ type: 'get_entries' }, { timeoutMs: 30000 })).data.entries;
    const entriesMs = performance.now() - start;
    assert.equal(entries.findLast(e => e.message?.role === 'user').message.content.filter(b => b.type === 'image').length, 10);
    const path = (await rpc.command({ type: 'get_state' })).data.sessionFile;
    const parseStart = performance.now();
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    const parsed = lines.map(JSON.parse);
    const parseMs = performance.now() - parseStart;
    assert.ok(parsed.some(e => e.message?.content?.filter?.(b => b.type === 'image').length === 10));
    const after = process.memoryUsage();
    clearInterval(sampler);
    await rpc.command({ type: 'prompt', message: '/b-memory' });
    const piMemory = (await f.logs()).findLast(r => r.kind === 'memory');
    observation(t, 'max-load', { repetition, sampledPeakRss, piRss: piMemory.rss, decodedBytes: 12 * MiB, maxLineBytes: Math.max(...lines.map(line => Buffer.byteLength(line))), sendMs, entriesMs, parseMs, driverRssBefore: before.rss, driverRssAfter: after.rss, driverHeapBefore: before.heapUsed, driverHeapAfter: after.heapUsed });
    const requestsBefore = (await f.e.requests()).length;
    for (const [name, invalid] of [
      ['single', [image(0, 24, 24, 4 * MiB + 1)]],
      ['count', Array(11).fill(small)],
      ['total', Array(4).fill(image(0, 24, 24, 4 * MiB - 1))],
    ]) {
      assert.ok(validateImages(invalid));
      const response = await fetch(f.bridge.url + '/api/assets/check', { method: 'POST', body: JSON.stringify({ images: invalid }) });
      assert.equal(response.status, 413);
      observation(t, 'limit', { name, browserSharedValidator: validateImages(invalid), server: await response.json() });
    }
    assert.equal((await f.e.requests()).length, requestsBefore);
  }
});

test('图片 14：停止取回两条 steer 的文本，用 nonce 查回原图片草稿，重复三次', async t => {
  const f = await fixture(t);
  const rpc = await f.start();
  for (let n = 0; n < 3; n++) {
    const count = (await f.e.requests()).length;
    await f.e.setScript({ routes: [{ when: { request: count + 1 }, reply: { segments: [{ type: 'hang' }] } }], fallback: textReply });
    const from = rpc.cursor;
    await rpc.command({ type: 'prompt', message: 'hang' });
    await f.e.waitForProvider(r => r.kind === 'hang' && r.request === count + 1);
    const drafts = [encode(images, undefined, 'stop01'), encode(images.toReversed(), undefined, 'stop02')];
    const pending = new Map(drafts.map(d => [d.message, structuredClone(d)]));
    for (const d of drafts) assert.equal((await rpc.command({ type: 'steer', ...d })).success, true);
    const cleared = await rpc.command({ type: 'clear_queue' });
    const returned = cleared.data.steering;
    assert.deepEqual(returned, drafts.map(d => d.message));
    assert.deepEqual(returned.map(text => pending.get(text)), drafts);
    await rpc.command({ type: 'abort' });
    await rpc.waitFor('agent_settled', { from });
    assert.equal((await f.e.requests()).length, count + 1);
    observation(t, 'clear-images', { repetition: n + 1, returnedFields: Object.keys(cleared.data), imagesInRpc: JSON.stringify(cleared.data).includes('base64'), draftLookupImages: drafts.map(d => d.images.length) });
  }
});

test('pane #9：new/resume/fork/clone/reload 连续替换，每次表单/图片/锁和 stale 检查', async t => {
  const f = await fixture(t);
  const rpc = await f.start();
  assert.equal((await rpc.command({ type: 'prompt', message: '/b-env' })).success, true);
  const firstSession = (await rpc.command({ type: 'get_state' })).data.sessionFile;
  await f.e.setScript({ turns: [{ segments: [{ type: 'toolCall', name: 'bash', arguments: { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ticket:!!process.env.PANE_BRIDGE_TICKET}))'` } }] }], fallback: textReply });
  await rpc.promptAndWait('pane bash env check');
  const bashResult = rpc.events.findLast(r => r.event.type === 'tool_execution_end' && r.event.toolName === 'bash').event;
  assert.equal(bashResult.isError, false);
  assert.match(JSON.stringify(bashResult.result), /ticket\\?"\s*:\s*false/);
  await rpc.promptAndWait('seed');
  let previous = f.bridge.latest;
  const gated = [];
  f.bridge.hooks.onShutdown = () => {
    void f.bridge.submit(rpc, { type: 'prompt', message: 'BLOCK_BEFORE_READY' }).then(result => gated.push(result));
  };
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const type of ['new_session', 'switch_session', 'fork', 'clone', 'reload']) {
      await rpc.promptAndWait('seed before replacement');
      const entries = (await rpc.command({ type: 'get_entries' })).data.entries;
      const id = entries.findLast(e => e.message?.role === 'user').id;
      const extCommand = { new_session: '/b-new', switch_session: `/b-resume ${firstSession}`, fork: `/b-fork ${id}`, clone: '/b-clone', reload: '/b-reload' };
      const request = repeat === 1 || type === 'reload' ? { type: 'prompt', message: extCommand[type] } : type === 'switch_session' ? { type, sessionPath: firstSession } : type === 'fork' ? { type, entryId: id } : { type };
      assert.equal((await rpc.command(request)).success, true);
      const current = await f.bridge.waitReady(previous);
      const old = await fetch(f.bridge.url + '/bridge/event', { method: 'POST', headers: { Authorization: `Bearer ${f.bridge.token}` }, body: JSON.stringify({ type: 'form', instance: previous }) });
      assert.equal(old.status, 409);
      assert.equal((await rpc.command({ type: 'prompt', message: '/b-stale' })).success, true);
      assert.equal((await f.logs()).findLast(r => r.kind === 'stale-result').error, 'bridge 409');
      const requestId = `form-${repeat}-${type}-${current}`;
      assert.equal((await rpc.command({ type: 'prompt', message: `/b-form ${requestId}` })).success, true);
      assert.equal((await rpc.command({ type: 'prompt', message: '/b-drain' })).success, true);
      const formLogs = await f.logs();
      const counts = {
        http: f.bridge.records.filter(r => r.type === 'form' && r.requestId === requestId).length,
        response: formLogs.filter(r => r.kind === 'form-response' && r.requestId === requestId).length,
        pong: formLogs.filter(r => r.kind === 'pong' && r.requestId === requestId).length,
      };
      observation(t, 'form-counts', { requestId, instance: current, ...counts, starts: formLogs.filter(r => r.kind === 'session-start' && r.instance === current).length });
      assert.deepEqual(counts, { http: 1, response: 1, pong: 1 });
      assert.equal(formLogs.filter(r => r.kind === 'listeners-bound' && r.instance === current).length, 1);
      assert.equal(f.bridge.records.filter(r => r.type === 'bridgeReady' && r.instance === current).length, 1);
      assert.equal((await rpc.command({ type: 'prompt', message: '/b-global-use' })).success, true);
      const sent = encode();
      await rpc.promptAndWait(sent.message, { images: sent.images });
      await assertRestored(f.e, rpc, sent);
      const logs = await f.logs();
      assert.equal(logs.findLast(r => r.kind === 'form-result').instance, current);
      assert.equal(logs.findLast(r => r.kind === 'restore').instance, current);
      assert.equal(logs.findLast(r => r.kind === 'peer-use').status, 200);
      const factory = logs.findLast(r => r.kind === 'factory');
      assert.equal(factory.ticketVisible, false);
      observation(t, 'replacement', { repeat, type, instance: current, staleStatus: old.status, formInstance: logs.findLast(r => r.kind === 'form-result').instance, peerCredentialUse: 200 });
      previous = current;
    }
  }
  f.bridge.hooks.onShutdown = undefined;
  const allLogs = await f.logs();
  assert.ok(allLogs.some(row => row.kind === 'session-start' && allLogs.filter(other => other.kind === 'session-start' && other.instance === row.instance).length === 2));
  assert.equal(f.bridge.records.filter(row => row.type === 'bridgeReady').length, 11);
  assert.equal(gated.length, 10);
  assert.ok(gated.every(result => result.error === 'bridge_not_ready'));
  assert.ok((await f.e.requests()).every(r => !r.lastUser.includes('BLOCK_BEFORE_READY')));
  assert.ok(f.bridge.records.some(r => r.type === 'lock' && r.status === 200));
  const child = (await f.logs()).find(r => r.kind === 'child-env');
  assert.equal(child.value.pane, false);
  observation(t, 'bridge-scope', { factories: (await f.logs()).filter(r => r.kind === 'factory').length, child: child.value, blockedBeforeReady: gated.length, locks: f.bridge.records.filter(r => r.type === 'lock').length, launches: f.bridge.records.filter(r => r.path === '/bridge/launch').length });
});

test('pane #9：先加载的扩展能看到 ticket；未就绪不发送；stdio input 可往返 JSON', async t => {
  const e = await createExperiment({ script: { fallback: textReply } });
  const logPath = join(e.root, 'bridge.jsonl');
  const bridge = await startBridge(join(e.root, 'server.jsonl'));
  t.diagnostic(`fixture: ${e.root}`);
  t.after(async () => { await e.stop(); await bridge.close(); if (t.passed && process.env.B_KEEP !== '1') await e.cleanup(); });
  assert.deepEqual(await bridge.submit({ command() { throw new Error('must not send'); } }, { type: 'prompt', message: 'unsafe' }), { success: false, error: 'bridge_not_ready' });
  const rpc = await e.start({ args: ['-e', join(here, 'peer.ts'), '-e', join(here, 'bridge.ts')], env: { B_LOG: logPath, B_URL: bridge.url, PANE_BRIDGE_TICKET: bridge.ticket }, ui: req => req.method === 'input' ? { value: JSON.stringify({ answers: ['A', 'B'] }) } : undefined });
  await bridge.waitReady();
  assert.equal((await readJsonl(logPath)).find(r => r.kind === 'peer-factory').paneTicket, true);
  assert.equal((await rpc.command({ type: 'prompt', message: '/b-stdio' })).success, true);
  assert.deepEqual((await readJsonl(logPath)).find(r => r.kind === 'stdio-result').value, { answers: ['A', 'B'] });
  const replay = await fetch(bridge.url + '/bridge/launch', { method: 'POST', body: JSON.stringify({ ticket: bridge.ticket }) });
  assert.equal(replay.status, 403);
  observation(t, 'stdio-and-ticket', { earlyPeerTicket: true, replayStatus: replay.status, requestMethod: 'input', response: { answers: ['A', 'B'] }, arbitraryRpcEvent: 'not implemented by pi' });
});

for (const order of ['first', 'last']) test(`agora #14：删除扩展位于 ${order}，MCP stdio 与 bash 继承`, async t => {
  const e = await createExperiment({ script: { fallback: textReply } });
  const logPath = join(e.root, 'bridge.jsonl');
  t.diagnostic(`fixture: ${e.root}`);
  t.after(async () => {
    await e.stop();
    const pids = (await readJsonl(logPath)).filter(r => r.kind === 'mcp' && r.action === 'start').map(r => r.pid);
    for (const pid of pids) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (alive) { process.kill(pid, 'SIGTERM'); throw new Error(`MCP retained pid ${pid}; terminated own child`); }
    }
    observation(t, 'mcp-cleanup', { pids, remaining: 0 });
    if (t.passed && process.env.B_KEEP !== '1') await e.cleanup();
  });
  await writeFile(join(e.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [join(here, 'fake-mcp.mjs')], exposure: 'direct' } } }));
  const a = join(here, 'agora-first.ts');
  const p = join(here, 'peer.ts');
  const extensions = order === 'first' ? [a, p, 'builtin:mcp'] : ['builtin:mcp', p, a];
  const rpc = await e.start({ args: extensions.flatMap(path => ['-e', path]), env: { B_LOG: logPath, AGORA_LAUNCH_TICKET: 'LOCAL_TEST_ONLY' } });
  await e.setScript({ turns: [{ segments: [{ type: 'toolCall', name: 'mcp__local__ping', arguments: {} }, { type: 'toolCall', name: 'bash', arguments: { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ticket:!!process.env.AGORA_LAUNCH_TICKET}))'` } }] }], fallback: textReply });
  await rpc.promptAndWait('run bash env check');
  const result = rpc.events.findLast(r => r.event.type === 'tool_execution_end' && r.event.toolName === 'bash').event;
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.result), /ticket\\?"\s*:\s*false/);
  const logs = await readJsonl(logPath);
  const peer = logs.find(r => r.kind === 'peer-factory');
  const mcp = logs.find(r => r.kind === 'mcp' && r.action === 'start');
  assert.ok(mcp, JSON.stringify(logs));
  assert.ok(logs.some(r => r.kind === 'mcp' && r.action === 'tools/call'));
  assert.equal(peer.agoraTicket, order === 'last');
  observation(t, 'agora-ticket', { order, factoryEvents: logs.filter(r => ['peer-factory', 'agora-delete'].includes(r.kind)), mcp, bashTicket: false, toolDeclared: (await e.requests())[0].tools.some(t => t.name === 'mcp__local__ping') });
});

test('图片 7：Claude、GPT Sol/Astra、Gemini 的语义识别', { skip: '需要真模型；本实验只允许假 provider，不发网络请求' }, () => {});
test('图片 13：浏览器实际上传/缩放后提示和拒绝', { skip: '尚无 pane 浏览器实现；共享校验器和 HTTP 原型已测，实际浏览器交互待测' }, () => {});
test('Windows / Linux 平台', { skip: '待测：本机为 macOS' }, () => {});
