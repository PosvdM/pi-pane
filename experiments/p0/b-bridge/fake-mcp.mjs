import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = data => appendFileSync(process.env.B_LOG, JSON.stringify({ at: Date.now(), kind: 'mcp', pid: process.pid, ...data }) + '\n');
log({ action: 'start', agoraTicket: Boolean(process.env.AGORA_LAUNCH_TICKET), paneTicket: Boolean(process.env.PANE_BRIDGE_TICKET) });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  log({ action: message.method });
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'b-fake', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'ping', description: '本地回声', inputSchema: { type: 'object', properties: {} } }] };
  if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'pong' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
lines.on('close', () => { log({ action: 'close' }); process.exit(0); });
process.on('SIGTERM', () => { log({ action: 'SIGTERM' }); process.exit(0); });
