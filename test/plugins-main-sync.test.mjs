import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Sessions } from "../packages/server/dist/sessions.js";
import { MainTree } from "../packages/server/dist/plugins/main-tree.js";
import { PaneServer } from "../packages/server/dist/server.js";

test("主树合并模型详情与目录时保留较新的活动时间，避免只读记录覆盖新存档活动", () => {
  const server = Object.create(PaneServer.prototype); const info = { ref: { source: "pane", id: "main" } };
  const older = "2026-01-01T00:00:00.000Z"; const newer = "2026-02-01T00:00:00.000Z";
  server.mainTreeMetadata = new Map([["main", { messageCount: 2, lastActivityAt: newer }]]);
  let current = { messageCount: 3, lastActivityAt: older, holds: [] };
  server.sessions = { mainSessionCatalog: () => [info], mainSessionDetails: () => current };
  assert.equal(server.mainTreeRows()[0].lastActivityAt, newer); assert.equal(server.mainTreeRows()[0].messageCount, 3);
  current = { ...current, lastActivityAt: "2026-03-01T00:00:00.000Z" }; assert.equal(server.mainTreeRows()[0].lastActivityAt, current.lastActivityAt);
  current = undefined; assert.equal(server.mainTreeRows()[0].lastActivityAt, newer); assert.equal(server.mainTreeRows()[0].messageCount, 2);
});

// 模型保持idle，排除agent/status事件代为通知的可能，直接验证增量提交切点。
test("增量条目提交后通知插件与树，标题和最终消息数不依赖后续状态事件", async () => {
  const sessions = Object.create(Sessions.prototype); sessions.knownMain = new Map(); sessions.mainListeners = new Set();
  const entry = { type: "message", id: "user", parentId: null, message: { role: "user", content: "首条持久文本" } };
  const model = { epoch: "e", status: "idle", entries: [], append(entries) { this.entries.push(...entries); } };
  const handle = { acceptingInput: true, async send(command) { return { data: { entries: command.since ? [] : [entry], leafId: "user" } }; } };
  const session = { id: "main", cwd: process.cwd(), file: path.resolve("main.jsonl"), model, handle, dirty: false, holds: new Map(), lastActive: 1000, name: { value: undefined } };
  sessions.records = new Map([[session.id, session]]);
  const api = sessions.mainSessions("observer"); const observations = [];
  const stopPlugin = api.onChange(() => observations.push({ title: api.get("main").title, count: sessions.mainSessionDetails("main").messageCount }));
  const tree = new MainTree({ load: async () => [], current: () => [{ info: api.get("main"), ...sessions.mainSessionDetails("main") }], watch: (listener) => api.onChange(listener) });
  let off;
  try {
    const initial = await tree.snapshot({ openNodeIds: ["pane:session:main"], recentSince: new Date(0).toISOString() });
    const before = initial.nodes.find(node => node.id === "pane:session:main"); assert.equal(before.title, "main"); assert.equal(before.messageCount, 0);
    const events = []; off = tree.subscribe({ epoch: initial.epoch, revision: initial.revision }, change => events.push(change));
    await sessions.sync(session); await new Promise(setImmediate);
    assert.deepEqual(observations, [{ title: "首条持久文本", count: 1 }]);
    const changed = events.find(change => change.type === "upsert" && change.node.id === "pane:session:main");
    assert.equal(changed.node.title, "首条持久文本"); assert.equal(changed.node.messageCount, 1); assert.equal(changed.node.lastActivityAt, new Date(1000).toISOString());
    const length = events.length; await sessions.sync(session); await new Promise(setImmediate); assert.equal(events.length, length, "无新条目的同步不能伪造树变更");
    assert.equal(sessions.mainSessionDetails("unknown"), undefined);
  } finally { off?.(); tree.close(); stopPlugin(); }
});
