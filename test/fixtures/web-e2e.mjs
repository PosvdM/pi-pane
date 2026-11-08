import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { requireChrome, launch, openPaired, startWebServer, assertNoPageErrors, screenshot } from "./browser.mjs";
import { piFixture, until } from "./helpers.mjs";
import { snapshot } from "./client.mjs";

export const replyScript = text => ({ fallback: { segments: [{ type: "text", text }] } });
export const slowReply = (text, delayMs = 60) => ({ segments: [{ type: "text", chunks: [...text].map(text => ({ text, delayMs })) }] });
export const byId = (page, id) => page.locator(`[data-testid="${id}"]`);

export async function records(file) {
  try { return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export function observePage(page) {
  page.paneErrors = [];
  page.on("console", message => {
    if (message.type() === "error" || /Content Security Policy/i.test(message.text())) page.paneErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", error => page.paneErrors.push(`pageerror: ${error.message}`));
  return page;
}

export async function setup(t, script, options = {}) {
  const executablePath = requireChrome(t);
  if (!executablePath) return null;
  const fixture = await piFixture(script);
  const state = { fixture, server: null, browser: null, context: null, pages: [], allowedErrors: options.allowedErrors ?? [] };
  t.after(async () => {
    try {
      for (const page of state.pages) {
        if (!t.passed && !page.isClosed()) await screenshot(page, `failure-${t.name.replace(/[^a-z0-9]/gi, "_")}-${state.pages.indexOf(page)}`);
        assertNoPageErrors(page, state.allowedErrors);
      }
    } finally {
      try { await state.browser?.close(); }
      finally { try { await state.server?.close(); } finally { await fixture.cleanup(); } }
    }
  });
  state.server = await startWebServer(fixture, options.serverOptions?.(fixture) ?? {});
  state.browser = await launch(executablePath);
  const { context, page } = await openPaired(state.browser, state.server);
  state.context = context; state.page = page; state.pages.push(page);
  page.setDefaultTimeout(15_000);
  t.diagnostic("Chrome 实际执行：" + state.browser.version());
  return state;
}

export async function newSession(page, fixture) {
  await byId(page, "new-session").click();
  await byId(page, "new-session-cwd").fill(fixture.cwd);
  await byId(page, "new-session-create").click();
  await byId(page, "composer").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
}

export async function send(page, text, button) {
  await byId(page, "composer").fill(text);
  // 完整命令直接发送，避免将 Enter 解释为补全选择。
  await byId(page, "composer").press("Escape");
  // 上一次控制请求未结束时输入框处于 busy，Enter 不会发送；先等发送按钮可用。
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="send"],[data-testid="steer"]'); return b && !b.disabled; });
  if (button) await byId(page, button).click(); else await byId(page, "composer").press("Enter");
  await until(async () => {
    if (await byId(page, "trust-yes").isVisible()) await byId(page, "trust-yes").click();
    return await byId(page, "model-button").isVisible() || await byId(page, "ui-dialog").isVisible();
  }, 30_000);
}

export async function sessionView(state, page = state.page) {
  const id = await byId(page, "chat").getAttribute("data-session-id");
  const credential = await page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-pane.auth")).credential);
  return snapshot(state.server, credential, id);
}

export async function idle(state, page = state.page) {
  return until(async () => {
    const view = await sessionView(state, page);
    return view.status === "idle" && view.inFlight?.phase === "idle" && view;
  }, 30_000);
}

export async function secondTab(state) {
  const page = observePage(await state.context.newPage());
  state.pages.push(page); page.setDefaultTimeout(15_000);
  await page.goto(state.server.origin);
  await byId(page, "sidebar").waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-pane.auth"))),
    await state.page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-pane.auth"))), "新标签页必须经 BroadcastChannel 取得相同凭证");
  assert.equal(new URL(page.url()).hash, "");
  const file = (await sessionView(state)).sessionFile;
  await sessionItem(page, file).click();
  await byId(page, "composer").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
  assert.equal(await byId(page, "chat").getAttribute("data-session-id"), (await sessionView(state)).ref.id);
  return page;
}

/** 侧栏中对应会话文件的条目；CSS 属性值中的反斜杠和引号需转义（Windows 路径）。 */
export function sessionItem(page, file) {
  const value = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return page.locator('[data-testid="session-item"][data-session-file="' + value + '"]');
}
