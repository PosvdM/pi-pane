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
 server.push(slow, message(4, "只更新水位")); assert.equal(slow.needsResync.get(JSON.stringify(["session", "pane", "s"])).cursor.seq, 4);
 slow.ws.bufferedAmount = 0; server.flush(slow); assert.equal(slow.sent.length, 1); assert.equal(slow.sent[0].event.type, "resync"); assert.equal(slow.pendingBytes, 0);
});

test("插件与主会话同名时，增量合并及重同步按完整来源隔离", () => {
 const server = Object.create(PaneServer.prototype); const slow = client();
 const own = message(1, "主会话"); const plugin = { ...message(1, "插件会话"), ref: { source: "sample", id: "s" } };
 server.push(slow, own); server.push(slow, plugin); assert.equal(slow.pending.length, 2);
 server.push(slow, { ...plugin, event: { ...plugin.event, assistantMessageEvent: { ...plugin.event.assistantMessageEvent, delta: "x".repeat(7 * 1024 * 1024) } } });
 assert.equal(slow.needsResync.size, 2);
 slow.ws.bufferedAmount = 0; server.flush(slow);
 assert.deepEqual(slow.sent.map(item => item.ref.source).sort(), ["pane", "sample"]);
 assert.ok(slow.sent.every(item => item.event.type === "resync"));
});
