import test from "node:test";
import assert from "node:assert/strict";
import { Sessions } from "../packages/server/dist/sessions.js";

// 只验证 refreshCatalog 的提交顺序：用最小的实例替代存储，不启动 pi。
function harness() {
  const pending = [];
  const sessions = Object.create(Sessions.prototype);
  Object.assign(sessions, {
    projects: new Set(["/p"]), storedById: new Map(), records: new Map(), files: new Map(), mainListeners: new Set(), catalogScans: 0, catalogCommitted: 0,
    store: { list: () => new Promise((resolve) => pending.push(resolve)) },
  });
  return { sessions, pending };
}
const raw = (id, name) => ({ id, path: `/p/${id}.jsonl`, cwd: "/p", name, firstMessage: "", messageCount: 1, modified: new Date("2026-01-01T00:00:00Z") });

test("#18 重叠的目录扫描逆序完成时，较早发起的扫描不回退已提交的目录", async () => {
  const { sessions, pending } = harness();
  let changes = 0; sessions.mainListeners.add(() => changes++);
  const early = sessions.refreshCatalog(); const late = sessions.refreshCatalog();
  pending[1]([raw("a", "新名称"), raw("b", "新会话")]);
  await late;
  pending[0]([raw("a", "旧名称")]);
  await early;
  assert.deepEqual([...sessions.storedById.keys()].sort(), ["a", "b"]);
  assert.equal(sessions.storedById.get("a").name, "新名称");
  assert.equal(changes, 1, "被淘汰的扫描不通知主会话树");
});
