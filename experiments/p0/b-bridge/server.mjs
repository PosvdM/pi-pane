import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { validateImages } from './images.mjs';

export async function startBridge(logPath) {
  const ticket = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  let used = false;
  let latest = 0;
  let ready = false;
  const records = [];
  const hooks = {};
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    const reply = (status, value) => {
      records.push({ at: Date.now(), path: req.url, ...data, ticket: undefined, token: undefined, status });
      appendFileSync(logPath, JSON.stringify(records.at(-1)) + '\n');
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    };
    if (req.url === '/api/assets/check') {
      const reason = validateImages(data.images);
      return reply(reason ? 413 : 200, { reason, sentToPi: false });
    }
    if (req.url === '/bridge/launch') {
      if (used || data.ticket !== ticket) return reply(403, { error: 'ticket_rejected' });
      used = true; return reply(200, { token, config: {} });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
    if (data.type === 'bridgeReady' && data.instance > latest) {
      latest = data.instance; ready = true; return reply(200, { ok: true });
    }
    if (data.instance !== latest) return reply(409, { error: 'stale_instance' });
    if (data.type === 'shutdown') { ready = false; hooks.onShutdown?.(); }
    if (data.type === 'form') return reply(200, { outcome: { status: 'submitted', answers: { pick: 'B' } } });
    return reply(200, { ok: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, ticket, token, records, hooks,
    get latest() { return latest; }, get ready() { return ready; },
    async waitReady(after = 0) {
      if (ready && latest > after) return latest;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clearInterval(interval); reject(new Error('bridge ready timeout')); }, 10000);
        const interval = setInterval(() => { if (ready && latest > after) { clearTimeout(timer); clearInterval(interval); resolve(latest); } }, 10);
      });
    },
    async submit(rpc, command) {
      if (!ready) return { success: false, error: 'bridge_not_ready' };
      return rpc.command(command);
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
