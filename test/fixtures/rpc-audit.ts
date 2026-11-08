import { appendFileSync } from "node:fs";
import { auditStdin } from "./stdin-audit.mjs";
const key = Symbol.for("pane-test.rpc-audit");
export default function() {
 if (globalThis[key]) return; globalThis[key] = true;
 auditStdin(process.stdin, command => appendFileSync(process.env.PANE_RPC_AUDIT, JSON.stringify({ type: command.type, since: command.since }) + "\n"));
}
