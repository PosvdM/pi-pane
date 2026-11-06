import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
function log(data) { appendFileSync(process.env.B_LOG, JSON.stringify({ at: Date.now(), ...data }) + '\n'); }
export default function(pi) {
  log({ kind: 'peer-factory', name: process.env.B_PEER_NAME || 'peer', paneTicket: Boolean(process.env.PANE_BRIDGE_TICKET), agoraTicket: Boolean(process.env.AGORA_LAUNCH_TICKET) });
  pi.on('session_start', () => {
    const conn = globalThis[Symbol.for('pi-pane.bridge')];
    log({ kind: 'peer-global', visible: Boolean(conn), instance: conn?.sequence });
  });
  const observers = [
    pi.events.on('pane:pong', value => log({ kind: 'pong', ...value })),
    pi.events.on('pane:form:response', value => log({ kind: 'form-response', ...value })),
  ];
  pi.on('session_shutdown', () => { for (const off of observers.splice(0)) off(); });
  pi.registerCommand('b-form', { handler: async args => {
    const requestId = args.trim() || randomUUID();
    let pong;
    const remove = pi.events.on('pane:pong', data => { if (data.requestId === requestId) pong = data; });
    pi.events.emit('pane:ping', { requestId });
    remove();
    if (!pong) throw new Error('No pong');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('form timeout')); }, 5000);
      const off = pi.events.on('pane:form:response', value => {
        if (value.requestId !== requestId) return;
        clearTimeout(timer); off(); log({ kind: 'form-result', ...value }); resolve();
      });
      pi.events.emit('pane:form:request', { requestId, spec: { title: '本地表单', questions: [{ id: 'pick', type: 'select', options: ['A', 'B'] }] } });
    });
  } });
  pi.registerCommand('b-global-use', { handler: async () => {
    const conn = globalThis[Symbol.for('pi-pane.bridge')];
    const response = await fetch(conn.url + '/bridge/event', {
      method: 'POST', headers: { Authorization: `Bearer ${conn.token}` },
      body: JSON.stringify({ type: 'peer-use', instance: conn.sequence }),
    });
    log({ kind: 'peer-use', status: response.status });
  } });
  pi.registerCommand('b-stale', { handler: async () => {
    const conn = globalThis[Symbol.for('pi-pane.bridge')];
    const old = conn.calls.at(-2);
    try { await old('form', { requestId: 'stale' }); throw new Error('stale unexpectedly accepted'); }
    catch (error) { log({ kind: 'stale-result', error: error.message }); }
  } });
  pi.registerCommand('b-stdio', { handler: async (_, ctx) => {
    const value = await ctx.ui.input(JSON.stringify({ type: 'pane:form', questions: ['one', 'two'] }));
    log({ kind: 'stdio-result', value: JSON.parse(value) });
  } });
  pi.registerCommand('b-env', { handler: async () => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({pane:!!process.env.PANE_BRIDGE_TICKET,agora:!!process.env.AGORA_LAUNCH_TICKET}))'], { encoding: 'utf8' });
    log({ kind: 'child-env', value: JSON.parse(result.stdout) });
  } });
  pi.registerCommand('b-new', { handler: async (_, ctx) => { await ctx.newSession(); } });
  pi.registerCommand('b-resume', { handler: async (path, ctx) => { await ctx.switchSession(path); } });
  pi.registerCommand('b-fork', { handler: async (id, ctx) => { await ctx.fork(id); } });
  pi.registerCommand('b-clone', { handler: async (_, ctx) => { await ctx.fork(ctx.sessionManager.getLeafId(), { position: 'at' }); } });
}
