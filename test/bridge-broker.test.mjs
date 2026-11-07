import test from "node:test";
import assert from "node:assert/strict";
import { BridgeBroker } from "../packages/server/dist/bridge.js";

test("实例认证独立于就绪：只认最新实例，旧请求拒绝，重复 ready 幂等", async () => {
  const broker = new BridgeBroker(); const events = [];
  const run = broker.issue({}, async event => { events.push(event); return { accepted: true }; });
  const { token } = broker.launch(run.ticket);
  const send = (type, instance, data = {}) => broker.event(token, { type, instance, ...data });
  const ready = { sessionFile: "/session.jsonl", sessionId: "session", reason: "startup" };
  await assert.rejects(send("bridgeReady", 1, ready), { code: "staleBridgeInstance" });
  await send("instance", 1); await send("lock", 1, { target: "/target.jsonl" });
  assert.equal(events.some(e => e.type === "bridgeReady"), false, "认证后未就绪仍可协调锁");
  await send("bridgeReady", 1, ready); await send("bridgeReady", 1, ready);
  assert.equal(events.filter(e => e.type === "bridgeReady").length, 1);
  await send("instance", 2);
  for (const type of ["lock", "shutdown", "trust", "bridgeReady"]) await assert.rejects(send(type, 1, ready), { code: "staleBridgeInstance" });
  await send("lock", 2, { target: "/target.jsonl" });
  await send("bridgeReady", 2, ready); await send("bridgeReady", 2, ready);
  assert.equal(events.filter(e => e.type === "bridgeReady").length, 2);
  await assert.rejects(send("bridgeReady", 2, { ...ready, sessionId: "different" }), { code: "bridgeReadyConflict" });
  await assert.rejects(send("instance", 1), { code: "staleBridgeInstance" });
  run.close(); await assert.rejects(send("lock", 2), { code: "invalidBridgeCredential" });
});
