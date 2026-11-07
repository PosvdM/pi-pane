import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { PaneServer } from "../packages/server/dist/server.js";
function client() { const sent = []; return { ws: { readyState: WebSocket.OPEN, bufferedAmount: 2 * 1024 * 1024, send: data => sent.push(JSON.parse(data)), close: () => {} }, state: "authed", pending: [], pendingBytes: 0, needsResync: new Map(), sent }; }
const message = (seq, delta) => ({ type: "session", ref: { source: "pane", id: "s" }, cursor: { epoch: "e", seq }, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } } });
test("慢客户端合并连续文本增量，超过 8 MiB 改发 resync，不阻塞其他连接", () => {
 const server = Object.create(PaneServer.prototype); const slow = client();
 server.push(slow, message(1, "前")); server.push(slow, message(2, "后"));
 assert.equal(slow.pending.length, 1); assert.equal(slow.pending[0].event.assistantMessageEvent.delta, "前后"); assert.equal(slow.pending[0].cursor.seq, 2);
 const fast = client(); fast.ws.bufferedAmount = 0; server.push(fast, message(3, "立即")); assert.equal(fast.sent.length, 1);
 server.push(slow, message(3, "x".repeat(7 * 1024 * 1024))); assert.equal(slow.pending.length, 0); assert.equal(slow.needsResync.size, 1);
 server.push(slow, message(4, "只更新水位")); assert.equal(slow.needsResync.get("s").cursor.seq, 4);
 slow.ws.bufferedAmount = 0; server.flush(slow); assert.equal(slow.sent.length, 1); assert.equal(slow.sent[0].event.type, "resync"); assert.equal(slow.pendingBytes, 0);
});
