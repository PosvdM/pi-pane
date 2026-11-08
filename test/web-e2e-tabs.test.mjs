import test from "node:test";
import assert from "node:assert/strict";
import { screenshot, startWebServer } from "./fixtures/browser.mjs";
import { until } from "./fixtures/helpers.mjs";
import { setup, byId, newSession, send, sessionView, idle, records, slowReply, secondTab, observePage } from "./fixtures/web-e2e.mjs";

test("Chrome 两个标签页并发发送时以真实 409 要求确认且只排队执行一次", { timeout: 120_000 }, async t => {
  const longReply = "并发测试的首条慢速输出：" + "甲乙丙丁戊己庚辛壬癸".repeat(12);
  const s = await setup(t, {
    turns: [{ segments: [{ type: "text", text: "会话预热完成" }] }, slowReply(longReply)],
    fallback: { segments: [{ type: "text", text: "第二个标签页只执行一次" }] },
  }, { allowedErrors: [/Failed to load resource: the server responded with a status of 409 \(Conflict\)/] }); if (!s) return;
  const { page, fixture } = s;
  await newSession(page, fixture);
  await send(page, "预热同一会话");
  await idle(s);
  await byId(page, "session-item").waitFor();
  const other = await secondTab(s);
  const stale = await sessionView(s, other);
  const pending = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let intercepted;
  const captured = new Promise(resolve => { intercepted = resolve; });
  // 暂存第二页在空闲状态产生的真实 UI 请求，等第一页开始运行后再交给服务端。
  await other.route("**/api/sessions/*/control", async route => {
    const body = route.request().postDataJSON(); pending.push(body);
    if (pending.length === 1) { intercepted(body); await gate; }
    await route.continue();
  });
  try {
    await send(other, "来自第二个标签页");
    const body = await captured;
    assert.equal(body.expectedRevision, stale.controlRevision);
    assert.equal(body.command.type, "prompt");
    await send(page, "来自第一个标签页");
    await until(async () => (await sessionView(s)).status === "running");
    const changed = await sessionView(s);
    assert.ok(changed.controlRevision > stale.controlRevision);
    const conflictResponse = other.waitForResponse(response => response.url().endsWith("/control") && response.status() === 409);
    release();
    const conflict = await conflictResponse;
    assert.equal((await conflict.json()).error, "revisionChanged");
    await byId(other, "choice-dialog").waitFor();
    assert.ok((await byId(other, "choice-dialog").textContent()).includes("会话已开始运行"));
    for (const choice of ["steer", "follow_up", "cancel"]) assert.equal(await byId(other, "choice-dialog").locator(`[data-choice="${choice}"]`).count(), 1);
    assert.equal(await byId(other, "composer").textContent(), "来自第二个标签页", "冲突未确认时必须保留草稿");
    assert.equal(pending.length, 1, "用户确认前不得自动重发");
    const before = (await records(fixture.env.FAKE_REQUEST_LOG)).filter(record => record.kind === "request");
    assert.deepEqual(before.map(record => record.lastUser), ["预热同一会话", "来自第一个标签页"]);
    await screenshot(other, "e2e-tabs-revision-conflict");
    await byId(other, "choice-dialog").locator('[data-choice="follow_up"]').click();
    await byId(other, "choice-dialog").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector('[data-testid="queue"]')?.textContent.includes("来自第二个标签页"));
    await other.waitForFunction(() => document.querySelector('[data-testid="composer"]').textContent === "");
    assert.equal(pending.length, 2);
    assert.equal(pending[1].command.type, "follow_up");
    assert.notEqual(pending[1].requestId, pending[0].requestId);
    await idle(s);
    await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).filter(record => record.kind === "done").length === 3);
    const requests = (await records(fixture.env.FAKE_REQUEST_LOG)).filter(record => record.kind === "request");
    assert.equal(requests.length, 3);
    assert.equal(requests.filter(record => record.lastUser === "来自第二个标签页").length, 1);
    await other.waitForFunction(() => document.querySelectorAll('[data-testid="user-message"]').length === 3);
    assert.equal((await byId(other, "user-message").allTextContents()).filter(text => text === "来自第二个标签页").length, 1);
    await screenshot(other, "e2e-tabs-sent-once");
  } finally { release(); await other.unroute("**/api/sessions/*/control"); }
});

test("Chrome 服务端同端口重启后旧页收到 401，新页不能继承失效凭证", { timeout: 90_000 }, async t => {
  const s = await setup(t, { turns: [] }, {
    allowedErrors: [
      /Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/,
      /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/,
    ],
  }); if (!s) return;
  const { page, context, fixture } = s;
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
  const oldAuth = await page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-pane.auth")));
  const origin = s.server.origin;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  // 保留旧页的内存凭证，先检查新页是否会经 BroadcastChannel 错误继承它。
  await page.route("**/api/ws-ticket", async route => { await gate; await route.continue(); });
  try {
    await context.setOffline(true);
    await byId(page, "net-banner").waitFor();
    await s.server.close(); s.server = null;
    s.server = await startWebServer(fixture, { port: Number(new URL(origin).port) });
    assert.equal(s.server.origin, origin);
    const freshInstance = await (await fetch(origin + "/api/instance")).json();
    assert.notEqual(freshInstance.instanceId, oldAuth.instanceId);
    await context.setOffline(false);
    const other = observePage(await context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
    await other.goto(origin);
    await byId(other, "pair-page").waitFor();
    assert.equal(await other.evaluate(() => sessionStorage.getItem("pi-pane.auth")), null);
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-pane.auth")).credential), oldAuth.credential, "检查新标签页时旧页应仍持有旧凭证");
    await screenshot(other, "e2e-restart-new-tab-pairing");
    const unauthorized = page.waitForResponse(response => response.url().endsWith("/api/ws-ticket") && response.status() === 401);
    release();
    const response = await unauthorized;
    assert.equal((await response.json()).instanceId, freshInstance.instanceId);
    await byId(page, "pair-page").waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("pi-pane.auth")), null);
    await byId(other, "pair-page").waitFor();
    await screenshot(page, "e2e-restart-old-tab-pairing");
  } finally { release(); await page.unroute("**/api/ws-ticket"); }
});
