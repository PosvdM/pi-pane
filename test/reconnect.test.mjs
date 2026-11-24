import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { requireChrome, launch } from "./fixtures/browser.mjs";
import { piFixture, until, delay } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { readSession } from "../packages/server/dist/store.js";
const reply = "真实断线重连不能重复或遗漏，结束后必须与会话文件一致。";
const script = { fallback: { segments: [{ type: "text", chunks: [...reply].map(text => ({ text, delayMs: 60 })) }] } };
function projection(initial, records) {
  const entries = new Map(initial.entries.map(e => [e.id, e])); let text = initial.inFlight?.assistant?.blocks.filter(b => b.type === "text").map(b => b.text).join("") ?? "";
  let cursor = initial.cursor;
  for (const record of records) {
    assert.equal(record.cursor.epoch, cursor.epoch); assert.equal(record.cursor.seq, cursor.seq + 1); cursor = record.cursor;
    const event = record.event;
    if (event.type === "pane_entries") for (const entry of event.entries) entries.set(entry.id, entry);
    if (event.type === "message_update") { const delta = event.assistantMessageEvent; if (delta.type === "text_delta") text += delta.delta; if (delta.type === "text_end") text = delta.content; }
    if (event.type === "message_end" && event.message.role === "assistant") text = event.message.content.filter(b => b.type === "text").map(b => b.text).join("");
    assert.notEqual(event.type, "resync", "缓冲仍保留时必须增量补齐");
  }
  return { entries: [...entries.values()], text, cursor };
}

test("Node 客户端在流式输出中断网重连，按游标补齐且不重复、不遗漏", { timeout: 60000 }, async () => {
  const f = await piFixture(script); const server = await startServer(f); let first; let second;
  try {
    const token = await pair(server); const initial = await open(server, token, f); const result = await control(server, token, initial, { type: "prompt", message: "重连测试" }); assert.equal(result.code, 200);
    const id = result.value.snapshot.ref.id;
    const cut = await until(async () => { const s = await snapshot(server, token, id); return s.inFlight?.assistant?.blocks.some(b => b.text?.length) && s; });
    first = await connect(server, token); first.subscribe(cut);
    await until(() => first.messages.some(m => m.event?.assistantMessageEvent?.type === "text_delta"));
    const before = first.messages.filter(m => m.type === "session"); const cursor = before.at(-1).cursor; first.close();
    await until(async () => { const s = await snapshot(server, token, id); return s.cursor.seq > cursor.seq + 5; });
    second = await connect(server, token); second.subscribe({ ...cut, cursor });
    await until(async () => (await snapshot(server, token, id)).status === "idle");
    await until(() => second.messages.some(m => m.event?.type === "pane_entries" && m.event.entries.some(e => e.message?.role === "assistant")));
    const all = [...before, ...second.messages.filter(m => m.type === "session")]; const rendered = projection(cut, all);
    const final = await snapshot(server, token, id); const disk = await readSession(final.sessionFile);
    assert.deepEqual(rendered.entries, disk.entries); assert.equal(rendered.text, reply);
    assert.equal(new Set(all.map(m => m.cursor.seq)).size, all.length);
  } finally { first?.close(); second?.close(); await server.close(); await f.cleanup(); }
});

const browserScript = `
window.harness = { events: [], credential: null, cursor: null, socket: null,
 async api(path, body) { const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + this.credential, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); if (!response.ok) throw Error(JSON.stringify(value)); return value; },
 async pair(code) { const r = await fetch('/api/auth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({code}) }); this.credential = (await r.json()).credential; },
 async connect(ref, after) { const {ticket} = await this.api('/api/ws-ticket', {}); const socket = this.socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws');
  await new Promise((resolve, reject) => { socket.onopen = () => socket.send(JSON.stringify({type:'auth',ticket,paneProtocol:[1,1]})); socket.onerror = reject;
  socket.onmessage = event => { const data = JSON.parse(event.data); if(data.type === 'banners') { socket.send(JSON.stringify({type:'subscribe',ref,after})); resolve(); } if(data.type === 'session') { this.events.push(data); this.cursor = data.cursor; } }; }); },
 disconnect() { this.socket.close(); this.socket = null; }
};`;
test("Chrome 在真实离线窗口后按游标重连，增量视图与磁盘一致", { timeout: 90000 }, async t => {
  const executablePath = requireChrome(t);
  if (!executablePath) return;
  const f = await piFixture(script); const webRoot = path.join(f.root, "page"); await mkdir(webRoot);
  await writeFile(path.join(webRoot, "index.html"), '<!doctype html><meta charset="utf-8"><script src="/harness.js"></script>'); await writeFile(path.join(webRoot, "harness.js"), browserScript);
  const server = await startServer(f, { webRoot }); let browser;
  try {
    browser = await launch(executablePath); const context = await browser.newContext(); const page = await context.newPage();
    await page.goto(server.origin); await page.evaluate(code => window.harness.pair(code), server.auth.issuePairCode());
    const token = await pair(server); const initial = await open(server, token, f); const result = await control(server, token, initial, { type: "prompt", message: "Chrome 重连测试" }); assert.equal(result.code, 200);
    const id = result.value.snapshot.ref.id; const cut = await until(async () => { const s = await snapshot(server, token, id); return s.inFlight?.assistant?.blocks.some(b => b.text?.length) && s; });
    await page.evaluate(s => window.harness.connect(s.ref, s.cursor), cut);
    await page.waitForFunction(() => window.harness.events.some(m => m.event?.assistantMessageEvent?.type === "text_delta"));
    await page.evaluate(() => window.harness.disconnect()); await context.setOffline(true); const cursor = await page.evaluate(() => window.harness.cursor);
    await until(async () => (await snapshot(server, token, id)).cursor.seq > cursor.seq + 5);
    await context.setOffline(false); await page.evaluate(({ref, cursor}) => window.harness.connect(ref, cursor), { ref: cut.ref, cursor });
    await page.waitForFunction(() => window.harness.events.some(m => m.event?.type === "pane_entries" && m.event.entries.some(e => e.message?.role === "assistant")));
    const events = await page.evaluate(() => window.harness.events); const rendered = projection(cut, events);
    const final = await snapshot(server, token, id); assert.deepEqual(rendered.entries, (await readSession(final.sessionFile)).entries); assert.equal(rendered.text, reply);
    assert.equal(new Set(events.map(m => m.cursor.seq)).size, events.length); t.diagnostic("Chrome 实际执行：" + browser.version());
  } finally { await browser?.close(); await server.close(); await f.cleanup(); }
});
