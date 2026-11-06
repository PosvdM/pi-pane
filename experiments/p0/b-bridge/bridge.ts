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
  const pendingForms = new Set();
  let start;
  function bindListeners() {
    log({ kind: 'listeners-bound', instance });
    off.push(pi.events.on('pane:ping', data => pi.events.emit('pane:pong', { ...data, instance })));
    off.push(pi.events.on('pane:form:request', data => {
      const job = (async () => {
        const result = await call('form', data);
        pi.events.emit('pane:form:response', { requestId: data.requestId, outcome: result.outcome, instance });
      })();
      pendingForms.add(job);
      void job.finally(() => pendingForms.delete(job)).catch(error => log({ kind: 'form-error', error: error.message }));
    }));
  }
  pi.on('session_start', async (event, ctx) => {
    log({ kind: 'session-start', instance, reason: event.reason });
    // RPC 替换可能对同一实例发两次 start，绑定和就绪请求只执行一次。
    if (!start) {
      bindListeners();
      start = call('bridgeReady', { reason: event.reason, sessionFile: ctx.sessionManager.getSessionFile(), trusted: ctx.isProjectTrusted() });
    }
    await start;
  });
  pi.on('before_provider_request', async event => {
    if (process.env.B_SYNC !== '1') return;
    const lastUser = event.payload.messages?.findLast(message => message.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content?.filter(block => block.type === 'text').map(block => block.text).join('');
    if (text?.startsWith('busy:')) await call('barrier', { barrierId: `provider:${text}` });
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
      if (process.env.B_SYNC === '1') {
        const text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        const nonce = text.match(/⟦pane-img:([a-z0-9]{6,8}):/)[1];
        await call('barrier', { barrierId: `restore:${nonce}` });
      }
      log({ kind: 'restore', instance, timestamp: event.message.timestamp, types: result.message.content.map(b => b.type) });
      return { message: result.message };
    }
  });
  pi.registerCommand('b-drain', { handler: async () => {
    await Promise.all([...pendingForms]);
    log({ kind: 'forms-drained', instance, pending: pendingForms.size });
  } });
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
