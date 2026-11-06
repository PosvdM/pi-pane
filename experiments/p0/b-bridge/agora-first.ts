import { appendFileSync } from 'node:fs';
export default function() {
  const visible = Boolean(process.env.AGORA_LAUNCH_TICKET);
  delete process.env.AGORA_LAUNCH_TICKET;
  appendFileSync(process.env.B_LOG, JSON.stringify({ at: Date.now(), kind: 'agora-delete', visible }) + '\n');
}
