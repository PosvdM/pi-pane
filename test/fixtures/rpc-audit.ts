import { appendFileSync } from "node:fs";
const key = Symbol.for("pane-test.rpc-audit");
export default function() {
 if (globalThis[key]) return; globalThis[key] = true;
 let pending = "";
 process.stdin.on("data", chunk => { pending += chunk.toString(); const lines = pending.split("\n"); pending = lines.pop(); for (const line of lines) { try { const command = JSON.parse(line); appendFileSync(process.env.PANE_RPC_AUDIT, JSON.stringify({ type: command.type, since: command.since }) + "\n"); } catch {} } });
}
