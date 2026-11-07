import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { piFixture, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";

test("真实 pi 的首次发送、since 条目与只读重连快照", { timeout: 60000 }, async () => {
  const fixture = await piFixture({ fallback: { segments: [{ type: "text", text: "测试回复" }] } });
  const server = await startServer(fixture);
  try {
    const token = await pair(server); const initial = await open(server, token, fixture);
    const sent = await control(server, token, initial, { type: "prompt", message: "第一条" });
    assert.equal(sent.code, 200, JSON.stringify(sent));
    const id = sent.value.snapshot.ref.id;
    const done = await until(async () => { const s = await snapshot(server, token, id); return s.status === "idle" && s.entries.filter(e => e.type === "message").length >= 2 && s; }, 20000);
    assert.equal(done.readonly, false); assert.match(JSON.stringify(done.entries), /测试回复/);
    const disk = await readFile(done.sessionFile, "utf8"); assert.match(disk, /第一条/);
    const again = await control(server, token, done, { type: "prompt", message: "第二条" });
    assert.equal(again.code, 200, JSON.stringify(again));
    await until(async () => (await snapshot(server, token, id)).status === "idle");
    const stopped = await control(server, token, await snapshot(server, token, id), { type: "close" }); assert.equal(stopped.code, 200, JSON.stringify(stopped));
  } finally { await server.close(); await fixture.cleanup(); }
});
