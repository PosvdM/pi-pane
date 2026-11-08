import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { screenshot } from "./fixtures/browser.mjs";
import { providerPath, uiExtensionPath, until } from "./fixtures/helpers.mjs";
import { setup, byId, newSession, send, idle, records, replyScript, secondTab } from "./fixtures/web-e2e.mjs";

const extensionOptions = { serverOptions: fixture => ({ extraExtensions: [providerPath, uiExtensionPath], env: { ...fixture.env, PANE_UI_LOG: path.join(fixture.root, "ui.jsonl") } }) };

async function hosted(t) {
  const s = await setup(t, replyScript("准备完成"), extensionOptions); if (!s) return null;
  await newSession(s.page, s.fixture);
  await send(s.page, "加载扩展");
  await byId(s.page, "assistant-message").waitFor();
  await idle(s);
  // 命令查询是异步的；补全列表出现扩展项后再执行命令。
  await byId(s.page, "composer").fill("/pane-dialogs");
  await byId(s.page, "completion").getByRole("option").filter({ hasText: "/pane-dialogs" }).waitFor();
  await byId(s.page, "composer").fill("");
  return s;
}

async function finishDialogs(page, inputText, editorText) {
  await byId(page, "ui-dialog").getByTestId("ui-option").filter({ hasText: /^绿$/ }).click();
  await byId(page, "ui-dialog").getByTestId("ui-confirm").click();
  await byId(page, "ui-dialog").getByTestId("ui-input").fill(inputText);
  await byId(page, "ui-dialog").getByTestId("ui-submit").click();
  await byId(page, "ui-dialog").locator("textarea").waitFor();
  await byId(page, "ui-input").fill(editorText);
  await byId(page, "ui-submit").click();
  await byId(page, "ui-dialog").waitFor({ state: "detached" });
}

test("Chrome 扩展对话框、超时、通知、组件及跨标签页回应", { timeout: 120_000 }, async t => {
  const s = await hosted(t); if (!s) return;
  const { page, fixture } = s;
  const logPath = path.join(fixture.root, "ui.jsonl");
  await send(page, "/pane-dialogs");
  await byId(page, "ui-dialog").waitFor();
  await screenshot(page, "e2e-extension-select");
  await finishDialogs(page, "浏览器名称", "编辑后的第一行\n编辑后的第二行");
  await byId(page, "toast").filter({ hasText: "对话框测试完成" }).waitFor();
  const expected = [
    { method: "select", result: "绿" }, { method: "confirm", result: true },
    { method: "input", result: "浏览器名称" }, { method: "editor", result: "编辑后的第一行\n编辑后的第二行" },
  ];
  await until(async () => (await records(logPath)).length === expected.length);
  assert.deepEqual(await records(logPath), expected);
  await screenshot(page, "e2e-extension-notify");
  await idle(s);
  await send(page, "/pane-dialog-timeout");
  await byId(page, "ui-dialog").waitFor();
  const shownAt = Date.now();
  assert.ok((await byId(page, "ui-dialog").textContent()).includes("会超时"));
  await screenshot(page, "e2e-extension-timeout");
  await byId(page, "ui-dialog").waitFor({ state: "detached", timeout: 6000 });
  const elapsed = Date.now() - shownAt;
  assert.ok(elapsed >= 700 && elapsed < 6000, `1500 毫秒超时的界面关闭耗时为 ${elapsed} 毫秒`);
  await until(async () => (await records(logPath)).length === 5);
  assert.deepEqual((await records(logPath)).at(-1), { method: "select", result: null });
  t.diagnostic(`1500 毫秒对话框超时的实测耗时：${elapsed} 毫秒`);
  await idle(s);
  await send(page, "/pane-widgets");
  await byId(page, "widget").waitFor();
  assert.equal(await byId(page, "widget").textContent(), "组件第一行\n组件第二行");
  await page.waitForFunction(() => document.title === "测试标题 · pi-pane" && document.querySelector('[data-testid="composer"]').textContent === "扩展写入的文字");
  assert.ok((await byId(page, "statusbar").textContent()).includes("状态文字"));
  await screenshot(page, "e2e-extension-widgets");
  await idle(s);
  const other = await secondTab(s);
  await send(page, "/pane-dialogs");
  await byId(page, "ui-dialog").waitFor();
  await byId(other, "ui-dialog").waitFor();
  await screenshot(other, "e2e-extension-other-tab");
  await byId(page, "ui-option").filter({ hasText: /^绿$/ }).click();
  // 另一个标签页必须关闭已回答的 select，而不是继续保留旧问题。
  await byId(other, "ui-option").first().waitFor({ state: "detached" });
  await byId(other, "ui-confirm").waitFor();
  await byId(page, "ui-confirm").click();
  await byId(other, "ui-confirm").waitFor({ state: "detached" });
  await byId(page, "ui-input").fill("共享名称");
  await byId(page, "ui-submit").click();
  await byId(page, "ui-dialog").locator("textarea").waitFor();
  await byId(page, "ui-input").fill("共享编辑结果");
  await byId(page, "ui-submit").click();
  await byId(page, "ui-dialog").waitFor({ state: "detached" });
  await byId(other, "ui-dialog").waitFor({ state: "detached" });
  await until(async () => (await records(logPath)).length === 9);
  assert.deepEqual((await records(logPath)).slice(5), [
    { method: "select", result: "绿" }, { method: "confirm", result: true },
    { method: "input", result: "共享名称" }, { method: "editor", result: "共享编辑结果" },
  ]);
  await screenshot(other, "e2e-extension-resolved-other-tab");
});

test("Chrome 斜杠命令补全支持方向键、Tab 并拒绝终端专用命令", { timeout: 90_000 }, async t => {
  const s = await hosted(t); if (!s) return;
  const { page } = s;
  await byId(page, "composer").fill("/");
  await byId(page, "completion").waitFor();
  for (const name of ["/compact", "/model", "/pane-dialogs"]) {
    await byId(page, "completion").getByRole("option").filter({ hasText: name }).waitFor();
  }
  assert.equal(await byId(page, "completion").locator('[aria-selected="true"] .cmd').textContent(), "/compact");
  await byId(page, "composer").press("ArrowDown");
  assert.equal(await byId(page, "completion").locator('[aria-selected="true"] .cmd').textContent(), "/model");
  await byId(page, "composer").press("ArrowUp");
  assert.equal(await byId(page, "completion").locator('[aria-selected="true"] .cmd').textContent(), "/compact");
  await byId(page, "composer").press("ArrowDown");
  await screenshot(page, "e2e-command-completion");
  await byId(page, "composer").press("Tab");
  assert.equal(await byId(page, "composer").textContent(), "/model ");
  await byId(page, "completion").waitFor({ state: "detached" });
  await send(page, "/settings");
  await byId(page, "toast").filter({ hasText: "pi-pane 不支持 /settings" }).waitFor();
  // 未执行的命令保留在输入框中，便于修改。
  assert.equal(await byId(page, "composer").textContent(), "/settings");
  assert.equal((await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(record => record.kind === "request").length, 1, "不支持的斜杠命令不得进入模型");
  await screenshot(page, "e2e-command-unsupported");
});
