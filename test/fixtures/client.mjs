import { randomUUID } from "node:crypto";
import { PaneServer } from "../../packages/server/dist/index.js";
import { providerPath, containment } from "./helpers.mjs";
export async function startServer(fixture, extra = {}) {
  return PaneServer.start({ home: fixture.root + "/pane", agentDir: fixture.agentDir, piPath: fixture.install.packageDir,
    port: 0, env: fixture.env, extraExtensions: [providerPath], containment,
    stopOptions: { abortTimeoutMs: 300, graceMs: 100, termGraceMs: 100 }, ...extra });
}
export async function pair(server) {
  const response = await fetch(server.origin + "/api/auth/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: server.auth.issuePairCode() }) });
  return (await response.json()).credential;
}
export async function request(server, token, route, body, method = body ? "POST" : "GET") {
  const response = await fetch(server.origin + route, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); return { code: response.status, value };
}
export const open = async (server, token, fixture, extra = {}) => (await request(server, token, "/api/sessions/open", { requestId: randomUUID(), cwd: fixture.cwd, ...extra })).value;
export const control = async (server, token, snapshot, command, extra = {}) => request(server, token, "/api/sessions/" + snapshot.ref.id + "/control", { requestId: randomUUID(), expectedEpoch: snapshot.cursor.epoch, expectedRevision: snapshot.controlRevision, command, ...extra });
export const snapshot = async (server, token, id) => (await request(server, token, "/api/sessions/" + id + "/snapshot")).value;
