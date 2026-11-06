import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { validateImages } from './images.mjs';

export async function startBridge(logPath) {
  const ticket = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  let used = false;
  let latest = 0;
  let ready = false;
  const records = [];
  const hooks = {};
  const changed = new EventEmitter();
  const barriers = new Map();
  function record(value) {
    const row = { at: Date.now(), ...value };
    records.push(row);
    appendFileSync(logPath, JSON.stringify(row) + '\n');
    changed.emit('record');
  }
  function waitFor(predicate, timeoutMs = 10000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); changed.off('record', check); error ? reject(error) : resolve(); };
      const check = () => { if (predicate()) finish(); };
      const timer = setTimeout(() => finish(new Error('bridge condition deadline exceeded')), timeoutMs);
      changed.on('record', check);
    });
  }
  function armBarrier(id) {
    if (barriers.has(id)) throw new Error(`Barrier already armed: ${id}`);
    let resume;
    const gate = { entered: false, released: false, promise: new Promise(resolve => { resume = resolve; }) };
    gate.release = () => { gate.released = true; resume(); };
    gate.waitEntered = () => waitFor(() => gate.entered);
    barriers.set(id, gate);
    return gate;
  }
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    const reply = (status, value) => {
      record({ path: req.url, ...data, ticket: undefined, token: undefined, status });
      if (res.destroyed) return;
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
    if (data.type === 'barrier') {
      const gate = barriers.get(data.barrierId);
      if (!gate) return reply(409, { error: 'barrier_not_armed' });
      gate.entered = true;
      record({ type: 'barrier-enter', barrierId: data.barrierId, instance: data.instance });
      await gate.promise;
      return reply(200, { ok: true });
    }
    if (data.type === 'shutdown') { ready = false; hooks.onShutdown?.(); }
    if (data.type === 'form') return reply(200, { outcome: { status: 'submitted', answers: { pick: 'B' } } });
    return reply(200, { ok: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, ticket, token, records, hooks, armBarrier,
    get latest() { return latest; }, get ready() { return ready; },
    async waitReady(after = 0) {
      await waitFor(() => ready && latest > after);
      return latest;
    },
    async submit(rpc, command) {
      if (!ready) return { success: false, error: 'bridge_not_ready' };
      return rpc.command(command);
    },
    async close() {
      for (const gate of barriers.values()) gate.release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
