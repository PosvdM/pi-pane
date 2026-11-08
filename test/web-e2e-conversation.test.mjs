import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSession } from "../packages/server/dist/store.js";
import { screenshot } from "./fixtures/browser.mjs";
import { until } from "./fixtures/helpers.mjs";
import { setup, byId, newSession, send, sessionView, idle, records, replyScript, slowReply } from "./fixtures/web-e2e.mjs";

const messages = (disk, role) => disk.entries.filter(entry => entry.message?.role === role).map(entry => entry.message);
const textOf = message => message.content.filter(block => block.type === "text").map(block => block.text).join("");

test("Chrome 配对、新建会话和安全 Markdown 回复", { timeout: 90_000 }, async t => {
  const reply = '完整回复开始\n\n```js\nconst answer = 42;\n```\n\n<img src=x onerror=alert(1)>\n\n[链接](javascript:alert(1))\n\n完整回复结束';
  const s = await setup(t, replyScript(reply)); if (!s) return;
  const { page, fixture } = s;
  // 项目资源使信任询问成为必经路径，不依赖本机配置。
  await mkdir(path.join(fixture.cwd, ".pi"));
  await writeFile(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
  assert.equal(new URL(page.url()).hash, "", "配对码必须从地址栏移除");
  await screenshot(page, "e2e-paired-sidebar");
  await newSession(page, fixture);
  await send(page, "请返回完整 Markdown 回复");
  const final = await idle(s);
  await byId(page, "assistant-message").waitFor();
  const assistant = byId(page, "assistant-message");
  const text = await assistant.textContent();
  for (const part of ["完整回复开始", "const answer = 42;", "<img src=x onerror=alert(1)>", "[链接](javascript:alert(1))", "完整回复结束"]) assert.ok(text.includes(part), part);
  assert.equal(await assistant.locator("pre.hljs").count(), 1);
  assert.equal(await assistant.locator("img, [onerror], a[href^='javascript:']").count(), 0);
  assert.equal(await assistant.locator("a").count(), 0, "恶意 Markdown 链接必须按文本显示");
  const disk = await readSession(final.sessionFile);
  assert.equal(textOf(messages(disk, "assistant")[0]), reply);
  await byId(page, "session-item").filter({ hasText: "请返回完整 Markdown 回复" }).waitFor();
  assert.equal(new URL(page.url()).hash, "");
  await screenshot(page, "e2e-conversation-markdown");
});

test("Chrome 流式断网恢复后仅显示一条与磁盘一致的完整回复", { timeout: 90_000 }, async t => {
  const reply = "流式断网恢复必须逐字补齐且不能重复：" + "甲乙丙丁戊己庚辛壬癸".repeat(6) + "结束。";
  const s = await setup(t, { fallback: slowReply(reply) }, {
    allowedErrors: [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/],
  }); if (!s) return;
  const { page, context, fixture } = s;
  await newSession(page, fixture);
  await send(page, "断网窗口验收");
  await page.waitForFunction(() => document.querySelector('[data-testid="streaming"]')?.textContent.includes("流式"));
  await context.setOffline(true);
  await byId(page, "net-banner").waitFor();
  const cut = await sessionView(s);
  await screenshot(page, "e2e-stream-offline");
  const progressed = await until(async () => {
    const view = await sessionView(s);
    return view.cursor.seq > cut.cursor.seq + 5 && view;
  });
  assert.ok(progressed.cursor.seq > cut.cursor.seq + 5, "浏览器离线期间服务端仍继续流式输出");
  await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
  const final = await idle(s);
  await page.waitForFunction(expected => {
    const items = document.querySelectorAll('[data-testid="assistant-message"]');
    return items.length === 1 && items[0].textContent.trim() === expected && !document.querySelector('[data-testid="streaming"]');
  }, reply);
  const disk = messages(await readSession(final.sessionFile), "assistant");
  assert.equal(disk.length, 1);
  assert.equal(textOf(disk[0]), reply);
  assert.equal((await byId(page, "assistant-message").textContent()).trim(), textOf(disk[0]));
  assert.equal(await byId(page, "assistant-message").count(), 1);
  await screenshot(page, "e2e-stream-restored");
});

test("Chrome 停止后按原顺序取回两条排队消息并保留现有草稿", { timeout: 90_000 }, async t => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "正在等待停止" }, { type: "hang" }] } }); if (!s) return;
  const { page, fixture } = s;
  await newSession(page, fixture);
  await send(page, "首条正在运行");
  await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).some(record => record.kind === "hang"));
  await byId(page, "stop").waitFor();
  const queued = ["排队消息一", "排队消息二"];
  for (let i = 0; i < queued.length; i++) {
    await send(page, queued[i], "follow-up");
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="queue"] .queued').length === count, i + 1);
    await page.waitForFunction(() => document.querySelector('[data-testid="composer"]').textContent === "");
  }
  assert.deepEqual(await byId(page, "queue").locator(".queued").allTextContents(), queued.map(text => "排队" + text));
  await byId(page, "composer").fill("尚未发送的草稿");
  await screenshot(page, "e2e-stop-queued");
  await byId(page, "stop").click();
  const expected = [...queued, "尚未发送的草稿"].join("\n\n");
  await page.waitForFunction(expected => document.querySelector('[data-testid="composer"]').innerText === expected, expected);
  await idle(s);
  await byId(page, "queue").waitFor({ state: "detached" });
  assert.equal(await byId(page, "composer").innerText(), expected);
  const log = await records(fixture.env.FAKE_REQUEST_LOG);
  assert.equal(log.filter(record => record.kind === "request").length, 1, "停止完成后不得执行任何排队请求");
  assert.ok(log.some(record => record.kind === "abort_received"));
  for (const text of queued) assert.ok(!log.some(record => record.kind === "request" && record.lastUser.includes(text)));
  await screenshot(page, "e2e-stop-restored");
});
