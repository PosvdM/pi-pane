import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { restore } from './images.mjs';

const key = Symbol.for('pi-pane.bridge');
function log(value) {
  appendFileSync(process.env.B_LOG, JSON.stringify({ at: Date.now(), ...value }) + '\n');
}

export default async function(pi) {
  const ticket = process.env.PANE_BRIDGE_TICKET;
  delete process.env.PANE_BRIDGE_TICKET;
  let conn = globalThis[key];
  if (!conn) {
    if (!ticket) throw new Error('bridge ticket missing');
    const response = await fetch(process.env.B_URL + '/bridge/launch', {
      method: 'POST', body: JSON.stringify({ ticket }),
    });
    if (!response.ok) throw new Error('bridge ticket rejected');
    conn = globalThis[key] = { ...(await response.json()), url: process.env.B_URL, sequence: 0 };
  }
  const instance = ++conn.sequence;
  log({ kind: 'factory', instance, ticketVisible: Boolean(ticket) });
  async function call(type, data = {}) {
    const response = await fetch(conn.url + '/bridge/event', {
      method: 'POST', headers: { Authorization: `Bearer ${conn.token}` },
      body: JSON.stringify({ type, instance, ...data }),
    });
    const result = await response.json();
    log({ kind: 'call', type, instance, status: response.status });
    if (!response.ok) throw new Error(`bridge ${response.status}`);
    return result;
  }
  (conn.calls ??= []).push(call);
  const off = [];
  pi.on('session_start', async (event, ctx) => {
    await call('bridgeReady', { reason: event.reason, sessionFile: ctx.sessionManager.getSessionFile(), trusted: ctx.isProjectTrusted() });
    off.push(pi.events.on('pane:ping', data => pi.events.emit('pane:pong', { ...data, instance })));
    off.push(pi.events.on('pane:form:request', async data => {
      const result = await call('form', data);
      pi.events.emit('pane:form:response', { requestId: data.requestId, outcome: result.outcome, instance });
    }));
  });
  pi.on('session_before_switch', async event => { await call('lock', { reason: event.reason, target: event.targetSessionFile }); });
  pi.on('session_before_fork', async event => { await call('lock', { reason: 'fork', entryId: event.entryId }); });
  pi.on('session_shutdown', async event => {
    for (const remove of off.splice(0)) remove();
    await call('shutdown', { reason: event.reason, target: event.targetSessionFile });
  });
  pi.on('message_end', async (event, ctx) => {
    const result = restore(event.message);
    if (result.invalid) ctx.ui.notify('图片顺序未还原', 'warning');
    if (result.message) {
      // 延迟用于检测模型请求是否真的等待替换完成。
      await new Promise(resolve => setTimeout(resolve, 35));
      log({ kind: 'restore', instance, timestamp: event.message.timestamp, types: result.message.content.map(b => b.type) });
      return { message: result.message };
    }
  });
  pi.registerCommand('b-resize', { handler: async args => {
    const hashes = [];
    for (const img of JSON.parse(args)) {
      const result = await resizeImage(Buffer.from(img.data, 'base64'), img.mimeType);
      hashes.push({ hash: createHash('sha256').update(result.data).digest('hex'), mimeType: result.mimeType, dimensions: [result.width, result.height] });
    }
    log({ kind: 'resize-reference', hashes });
  } });
  pi.registerCommand('b-memory', { handler: async () => { log({ kind: 'memory', instance, ...process.memoryUsage() }); } });
  pi.registerCommand('b-reload', { handler: async (_, ctx) => { await ctx.reload(); } });
}
