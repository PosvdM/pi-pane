import fault from "./bridge-fault.ts";
import bridge from "../../packages/bridge-extension/dist/index.js";
export default async function(pi) { await fault(pi); await bridge(pi); }
