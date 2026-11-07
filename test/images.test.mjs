import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { readSession } from "../packages/server/dist/store.js";
import { piFixture, until, providerPath } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
const thumbnail = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
async function upload(server, token, image, mime = "image/png") {
 const form = new FormData(); form.append("image", new Blob([image], { type: mime }), "image.png"); form.append("thumb", new Blob([thumbnail], { type: "image/webp" }), "thumb.webp");
 const response = await fetch(server.origin + "/api/assets", { method: "POST", headers: { Authorization: "Bearer " + token, "X-Request-Id": randomUUID() }, body: form }); return { code: response.status, value: await response.json() };
}
test("4 MiB 图片及 10 图 12 MiB 上限实测，快照用引用、since 增量和缓存缺失重建", { timeout: 120000 }, async t => {
 const f = await piFixture({ fallback: { segments: [{ type: "text", text: "图片回复" }] } }); f.env.PANE_RPC_AUDIT = path.join(f.root, "rpc.jsonl");
 const settingsFile = path.join(f.agentDir, "settings.json"); const settings = JSON.parse(await readFile(settingsFile, "utf8")); settings.images = { autoResize: false }; await writeFile(settingsFile, JSON.stringify(settings));
 const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/rpc-audit.ts", import.meta.url))] });
 let sampler;
 try {
  const token = await pair(server); const maxImage = png(0, 24, 24, 4 * 1024 * 1024); const small = png(1);
  const max = await upload(server, token, maxImage); assert.equal(max.code, 200, JSON.stringify(max));
  const tooLarge = await upload(server, token, png(0, 24, 24, 4 * 1024 * 1024 + 1)); assert.equal(tooLarge.code, 413);
  const badMime = await upload(server, token, small, "image/jpeg"); assert.equal(badMime.code, 400);
  const third = await upload(server, token, png(2, 24, 24, 4 * 1024 * 1024 - small.length * 7)); const little = await upload(server, token, small);
  assert.equal(third.code, 200); assert.equal(little.code, 200);
  const draft = [max.value.assetId, max.value.assetId, third.value.assetId, ...Array(7).fill(little.value.assetId)].flatMap((assetId, i) => [{ type: "text", text: "段" + (i + 1) }, { type: "image", assetId }]);
  const initial = await open(server, token, f); let peak = process.memoryUsage().rss; sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const begin = performance.now(); const sent = await control(server, token, initial, { type: "prompt" }, { draft }); assert.equal(sent.code, 200, JSON.stringify(sent).slice(0, 1000));
  const id = sent.value.snapshot.ref.id; const done = await until(async () => { const s = await snapshot(server, token, id); return s.status === "idle" && s.entries.some(e => e.message?.role === "assistant") && s; }, 30000);
  const elapsed = performance.now() - begin; assert.ok(JSON.stringify(done).length < 50000); assert.equal(JSON.stringify(done).includes('"data"'), false);
  const user = done.entries.find(e => e.message?.role === "user").message; assert.equal(user.content.length, 20); assert.equal(user.content.filter(b => b.blob).length, 10);
  const image = user.content.find(b => b.blob); let response = await fetch(server.origin + "/api/blobs/" + image.blob, { headers: { Authorization: "Bearer " + token } }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), maxImage);
  await unlink(path.join(f.root, "pane/cache/blobs", image.blob.slice(7))); response = await fetch(server.origin + "/api/blobs/" + image.blob, { headers: { Authorization: "Bearer " + token } }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), maxImage);
  const secondStart = performance.now(); const next = await control(server, token, done, { type: "prompt", message: "不重发历史图片" }); assert.equal(next.code, 200); await until(async () => (await snapshot(server, token, id)).status === "idle");
  const audit = (await readFile(f.env.PANE_RPC_AUDIT, "utf8")).trim().split("\n").map(JSON.parse).filter(c => c.type === "get_entries"); assert.equal(audit.filter(c => !c.since).length, 1); assert.ok(audit.filter(c => c.since).length >= 2);
  const disk = await readFile(done.sessionFile, "utf8"); const maxLine = Math.max(...disk.split("\n").map(line => Buffer.byteLength(line))); assert.ok((await readSession(done.sessionFile)).entries.some(e => e.message?.role === "user"));
  t.diagnostic(JSON.stringify({ singleImageBytes: maxImage.length, messageImageBytes: 12 * 1024 * 1024, imageCount: 10, maxJsonlLineBytes: maxLine, sendToSettledMs: Math.round(elapsed), nextSendMs: Math.round(performance.now() - secondStart), serverPeakRssBytes: peak, snapshotBytes: Buffer.byteLength(JSON.stringify(done)), getEntriesFull: audit.filter(c => !c.since).length, getEntriesIncremental: audit.filter(c => c.since).length }));
 } finally { clearInterval(sampler); await server.close(); await f.cleanup(); }
});
