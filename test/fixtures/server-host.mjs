import path from "node:path";
import { PaneServer } from "../../packages/server/dist/index.js";
const f = JSON.parse(process.env.PANE_FIXTURE);
const server = await PaneServer.start({ home: path.join(f.root, "pane"), agentDir: f.agentDir, piPath: f.piPath, port: 0, env: process.env,
  extraExtensions: [f.providerPath], containment: f.containment, stopOptions: { abortTimeoutMs: 300, graceMs: 100, termGraceMs: 100 } });
process.send({ origin: server.origin, code: server.auth.issuePairCode() });
