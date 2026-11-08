import { WebSocket } from "ws";
import { request } from "./client.mjs";
import { until } from "./helpers.mjs";
export async function connect(server, token, options = {}) {
  const ticket = options.ticket ?? (await request(server, token, "/api/ws-ticket", {})).value.ticket;
  const ws = new WebSocket(server.origin.replace("http:", "ws:") + "/ws", { origin: server.origin, ...options.ws });
  const messages = []; let closed;
  ws.on("message", data => messages.push(JSON.parse(data.toString()))); ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify(options.firstFrame ?? { type: "auth", ticket, paneProtocol: [1, 1] }));
  await until(() => messages.length || closed);
  return { ws, messages, get closed() { return closed; }, subscribe(snapshot) { ws.send(JSON.stringify({ type: "subscribe", ref: snapshot.ref, after: snapshot.cursor })); }, close() { ws.terminate(); } };
}
