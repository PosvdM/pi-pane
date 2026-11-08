import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSession } from "../packages/server/dist/store.js";
import { openPaired } from "./fixtures/browser.mjs";
import { providerPath, uiExtensionPath, until } from "./fixtures/helpers.mjs";
import { setup, byId, newSession, send, idle, sessionView, records, replyScript, secondTab } from "./fixtures/web-e2e.mjs";

const progressTool = fileURLToPath(new URL("./fixtures/progress-tool.ts", import.meta.url));
const extensionOptions = {
  serverOptions: fixture => ({ extraExtensions: [providerPath, uiExtensionPath], env: { ...fixture.env, PANE_UI_LOG: path.join(fixture.root, "ui.jsonl") } }),
};
const networkErrors = [/Failed to load resource: net::ERR_FAILED/, /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/];
const item = (page, view) => byId(page, "session-item").and(page.getByTitle(view.sessionFile, { exact: true }));
const latch = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

async function opened(page, view) {
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, view.ref.id);
  await byId(page, "composer").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
}
async function choose(page, view) {
  await item(page, view).click();
  await opened(page, view);
}
async function create(s, title) {
  await newSession(s.page, s.fixture);
  await send(s.page, title);
  await s.page.waitForFunction(title => [...document.querySelectorAll('[data-testid="user-message"]')].some(el => el.textContent === title), title);
  const view = await idle(s);
  await item(s.page, view).waitFor();
  return view;
}
async function hosted(t, script = replyScript("准备完成"), options = extensionOptions) {
  const s = await setup(t, script, options); if (!s) return null;
  await create(s, "加载回归测试会话");
  await byId(s.page, "composer").fill("/pane-dialogs");
  await byId(s.page, "completion").getByRole("option").filter({ hasText: "/pane-dialogs" }).waitFor();
  await byId(s.page, "composer").fill("");
  return s;
}
async function finishDialogs(page) {
  await byId(page, "ui-confirm").click();
  await byId(page, "ui-input").fill("回归名称");
  await byId(page, "ui-submit").click();
  await byId(page, "ui-dialog").locator("textarea").waitFor();
  await byId(page, "ui-input").fill("回归文本");
  await byId(page, "ui-submit").click();
  await byId(page, "ui-dialog").waitFor({ state: "detached" });
}
async function renderSettled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("R1 Chrome 已保存草稿在最后一次编辑后立即切换会话仍完整", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("已回复")); if (!s) return;
  const { page } = s;
  const a = await create(s, "草稿会话甲");
  const b = await create(s, "草稿会话乙");
  await choose(page, a);
  const key = `pi-pane.draft.${a.ref.id}`;
  await byId(page, "composer").fill("已保存草稿");
  await page.waitForFunction(key => localStorage.getItem(key) === JSON.stringify([{ type: "text", text: "已保存草稿" }]), key);
  // 编辑与点击发生在同一浏览器任务中，确定早于 300 毫秒保存计时器。
  await page.evaluate(file => {
    const editor = document.querySelector('[data-testid="composer"]'); editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.execCommand("insertText", false, "末");
    [...document.querySelectorAll('[data-testid="session-item"]')].find(el => el.title === file).click();
  }, b.sessionFile);
  await opened(page, b);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), [{ type: "text", text: "已保存草稿末" }]);
  await choose(page, a);
  assert.equal(await byId(page, "composer").innerText(), "已保存草稿末");
  await page.waitForFunction(key => localStorage.getItem(key) === JSON.stringify([{ type: "text", text: "已保存草稿末" }]), key);
});

test("R1 Chrome 图片草稿先显示，慢 touch 只标记过期图片且保留期间编辑", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("已回复")); if (!s) return;
  const { page } = s;
  const a = await create(s, "图片草稿甲");
  const b = await create(s, "图片草稿乙");
  const assetId = "sha256-" + "a".repeat(64);
  await page.evaluate(({ id, assetId }) => localStorage.setItem(`pi-pane.draft.${id}`, JSON.stringify([
    { type: "text", text: "图片草稿" }, { type: "image", assetId },
  ])), { id: a.ref.id, assetId });
  const gate = latch(); let captured = false;
  await page.route("**/api/assets/touch", async route => {
    const response = await route.fetch(); captured = true;
    await gate.promise; await route.fulfill({ response });
  });
  try {
    await choose(page, a);
    await until(() => captured);
    assert.equal(await byId(page, "composer").locator(".chip").getAttribute("data-asset-id"), assetId);
    assert.equal(await byId(page, "composer").innerText(), "图片草稿");
    await byId(page, "composer").press("Control+End");
    await page.keyboard.insertText("等待期间的新编辑");
    const delivered = page.waitForResponse(response => response.url().endsWith("/api/assets/touch"));
    gate.release(); await delivered;
    await byId(page, "composer").locator(".chip.expired").waitFor();
    assert.equal(await byId(page, "composer").innerText(), "图片草稿等待期间的新编辑");
    await choose(page, b);
    await choose(page, a);
    assert.equal(await byId(page, "composer").innerText(), "图片草稿等待期间的新编辑");
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("R2 Chrome 未启动会话拒绝 settings 并保留输入，不调用模型", { timeout: 60_000 }, async t => {
  const s = await setup(t, replyScript("不应调用")); if (!s) return;
  const { page, fixture } = s;
  await newSession(page, fixture);
  await byId(page, "composer").fill("/settings");
  await byId(page, "composer").press("Escape");
  await byId(page, "composer").press("Enter");
  await byId(page, "toast").filter({ hasText: "pi-pane 不支持 /settings" }).waitFor();
  assert.equal(await byId(page, "composer").innerText(), "/settings");
  assert.equal((await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length, 0);
  assert.equal((await sessionView(s)).hosted, false);
  assert.equal(await byId(page, "model-button").count(), 0);
  assert.match(await byId(page, "chat").textContent(), /未启动（发送消息后启动 pi）/);
});

test("R2 Chrome 运行中的扩展命令仍通过 prompt 执行 widget", { timeout: 90_000 }, async t => {
  const s = await hosted(t, {
    turns: [{ segments: [{ type: "text", text: "准备完成" }] }],
    fallback: { segments: [{ type: "text", text: "持续运行" }, { type: "hang" }] },
  }); if (!s) return;
  const { page, fixture } = s;
  await send(page, "慢速运行");
  await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).some(row => row.kind === "hang"));
  const bodies = [];
  await page.route("**/api/sessions/*/control", async route => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  try {
    await send(page, "/pane-widgets");
    await byId(page, "widget").waitFor();
    assert.equal(await byId(page, "widget").textContent(), "组件第一行\n组件第二行");
    await page.waitForFunction(() => document.querySelector('[data-testid="composer"]').textContent === "扩展写入的文字");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].command.type, "prompt");
    assert.deepEqual(bodies[0].draft, [{ type: "text", text: "/pane-widgets" }]);
    assert.doesNotMatch((await byId(page, "toast").allTextContents()).join("\n"), /rpcRejected/);
    assert.equal((await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length, 2);
  } finally { await page.unroute("**/api/sessions/*/control"); }
  await byId(page, "stop").click();
  await idle(s);
});

test("R2 Chrome 内置命令遇到真实 revision 冲突时保留完整输入", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("准备完成"), {
    allowedErrors: [/Failed to load resource: the server responded with a status of 409 \(Conflict\)/],
  }); if (!s) return;
  const { page } = s;
  await create(s, "命令冲突会话");
  const other = await secondTab(s);
  const gate = latch(); let captured;
  await page.route("**/api/sessions/*/control", async route => {
    captured = route.request().postDataJSON(); await gate.promise; await route.continue();
  });
  try {
    await send(page, "/name 这份名称参数必须保留");
    await until(() => captured);
    await send(other, "/thinking high");
    await other.waitForFunction(() => document.querySelector('[data-testid="composer"]').textContent === "");
    const response = page.waitForResponse(response => response.url().endsWith("/control") && response.status() === 409);
    gate.release();
    assert.equal((await (await response).json()).error, "revisionChanged");
    await byId(page, "toast").filter({ hasText: "会话状态已变化，请确认后重新执行命令" }).waitFor();
    assert.equal(await byId(page, "composer").innerText(), "/name 这份名称参数必须保留");
    assert.equal(captured.command.type, "set_session_name");
    assert.equal(captured.command.name, "这份名称参数必须保留");
    assert.notEqual((await sessionView(s)).state.sessionName, "这份名称参数必须保留");
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("R3 Chrome 另一标签页同步名称与思考级别", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("准备完成")); if (!s) return;
  const { page } = s;
  await create(s, "状态同步会话");
  const other = await secondTab(s);
  await send(page, "/name 跨标签页新名字");
  for (const tab of [page, other]) await tab.waitForFunction(() => document.querySelector('[data-testid="session-title"]')?.textContent === "跨标签页新名字");
  await page.waitForFunction(() => document.querySelector('[data-testid="composer"]').textContent === "");
  await send(page, "/thinking high");
  for (const tab of [page, other]) await tab.waitForFunction(() => document.querySelector('[data-testid="thinking-button"]')?.textContent === "思考：high");
  const view = await sessionView(s, other);
  assert.equal(view.state.sessionName, "跨标签页新名字");
  assert.equal(view.state.thinkingLevel, "high");
});

test("R4 Chrome 离线期间别页回答后，恢复只显示待答 confirm", { timeout: 90_000 }, async t => {
  const s = await hosted(t, replyScript("准备完成"), { ...extensionOptions, allowedErrors: networkErrors }); if (!s) return;
  const { page, context } = s;
  // 独立 context 使 setOffline 只影响 A；B 仍连接同一真实服务端。
  const paired = await openPaired(s.browser, s.server); const other = paired.page;
  s.pages.push(other); other.setDefaultTimeout(15_000);
  const view = await sessionView(s);
  await choose(other, view);
  await send(page, "/pane-dialogs");
  await byId(page, "ui-option").first().waitFor();
  await byId(other, "ui-option").first().waitFor();
  await context.setOffline(true);
  try {
    await byId(page, "net-banner").waitFor();
    await byId(other, "ui-option").filter({ hasText: /^绿$/ }).click();
    await byId(other, "ui-confirm").waitFor();
    assert.equal(await byId(page, "ui-option").count(), 3, "离线页应保留旧 select，确保测试确实经过失同步窗口");
  } finally { await context.setOffline(false); }
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
  await byId(page, "ui-confirm").waitFor();
  assert.equal(await byId(page, "ui-option").count(), 0);
  assert.match(await byId(page, "ui-dialog").textContent(), /确认继续/);
  await finishDialogs(page);
  await byId(other, "ui-dialog").waitFor({ state: "detached" });
  await until(async () => (await records(path.join(s.fixture.root, "ui.jsonl"))).length === 4);
  assert.deepEqual(await records(path.join(s.fixture.root, "ui.jsonl")), [
    { method: "select", result: "绿" }, { method: "confirm", result: true },
    { method: "input", result: "回归名称" }, { method: "editor", result: "回归文本" },
  ]);
});

test("R4 Chrome UI POST 失败后保留对话框，相同答案复用 requestId", { timeout: 90_000 }, async t => {
  const s = await hosted(t, replyScript("准备完成"), { ...extensionOptions, allowedErrors: networkErrors }); if (!s) return;
  const { page } = s;
  await send(page, "/pane-dialogs");
  const bodies = [];
  await page.route("**/api/sessions/*/ui", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.abort("failed"); else await route.continue();
  });
  try {
    await byId(page, "ui-option").filter({ hasText: /^绿$/ }).click();
    await byId(page, "toast").filter({ hasText: "回应未送达" }).waitFor();
    assert.equal(await byId(page, "ui-option").count(), 3);
    assert.equal(await byId(page, "net-banner").count(), 0, "仅 HTTP 回答失败，WebSocket 保持连接");
    assert.deepEqual(await records(path.join(s.fixture.root, "ui.jsonl")), []);
    await byId(page, "ui-option").filter({ hasText: /^绿$/ }).click();
    await byId(page, "ui-confirm").waitFor();
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], bodies[0], "同一答案的重试必须复用完整请求体与 requestId");
    await finishDialogs(page);
    await until(async () => (await records(path.join(s.fixture.root, "ui.jsonl"))).length === 4);
    assert.deepEqual((await records(path.join(s.fixture.root, "ui.jsonl")))[0], { method: "select", result: "绿" });
  } finally { await page.unroute("**/api/sessions/*/ui"); }
});

test("R4 Chrome 信任回答失败后保留询问并复用 requestId", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("信任回答后继续"), { allowedErrors: networkErrors }); if (!s) return;
  const { page, fixture } = s;
  await mkdir(path.join(fixture.cwd, ".pi"));
  await writeFile(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
  await newSession(page, fixture);
  const bodies = [];
  await page.route("**/api/trust/*", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.abort("failed"); else await route.continue();
  });
  try {
    await byId(page, "composer").fill("等待信任回答");
    await byId(page, "composer").press("Enter");
    await byId(page, "trust-yes").click();
    await byId(page, "toast").filter({ hasText: "回答未送达" }).waitFor();
    assert.equal(await byId(page, "trust-dialog").count(), 1);
    assert.equal((await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length, 0);
    await byId(page, "trust-yes").click();
    await byId(page, "assistant-message").waitFor();
    await byId(page, "trust-dialog").waitFor({ state: "detached" });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], bodies[0]);
    await idle(s);
  } finally { await page.unroute("**/api/trust/*"); }
});

test("R5 Chrome 服务端执行后丢弃响应，自动复用请求且模型只执行一次", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("幂等回复"), { allowedErrors: networkErrors }); if (!s) return;
  const { page, fixture } = s;
  await create(s, "幂等预热");
  const bodies = [];
  await page.route("**/api/sessions/*/control", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      const response = await route.fetch();
      assert.equal(response.status(), 200, "响应必须先由真实服务端生成，再模拟途中丢失");
      assert.equal((await response.json()).status, "accepted");
      await route.abort("failed");
    } else await route.continue();
  });
  try {
    await send(page, "响应丢失但不得重复执行");
    await byId(page, "toast").filter({ hasText: "网络中断，恢复后自动核对这次操作的结果" }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="composer"]').textContent === "");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 2);
    const view = await idle(s);
    assert.ok(bodies.length >= 2);
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    assert.equal(new Set(bodies.map(body => body.requestId)).size, 1);
    const requests = (await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request" && row.lastUser === "响应丢失但不得重复执行");
    assert.equal(requests.length, 1);
    const users = (await readSession(view.sessionFile)).entries.filter(entry => entry.message?.role === "user");
    assert.equal(users.filter(entry => entry.message.content.some(block => block.text === "响应丢失但不得重复执行")).length, 1);
    assert.equal((await byId(page, "user-message").allTextContents()).filter(text => text === "响应丢失但不得重复执行").length, 1);
    assert.deepEqual((await byId(page, "assistant-message").allTextContents()).map(text => text.trim()), ["幂等回复", "幂等回复"]);
  } finally { await page.unroute("**/api/sessions/*/control"); }
});

test("R6 Chrome 较早打开响应晚到不能覆盖最后选择的会话", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("已回复")); if (!s) return;
  const { page } = s;
  const a = await create(s, "导航会话甲");
  const b = await create(s, "导航会话乙");
  const gate = latch(); let captured = false;
  await page.route("**/api/sessions/open", async route => {
    if (route.request().postDataJSON().sessionFile !== a.sessionFile) { await route.continue(); return; }
    const response = await route.fetch(); captured = true;
    await gate.promise; await route.fulfill({ response });
  });
  try {
    await item(page, a).click(); await until(() => captured);
    await choose(page, b);
    const delivered = page.waitForResponse(response => response.url().endsWith("/api/sessions/open") && response.request().postDataJSON().sessionFile === a.sessionFile);
    gate.release(); await (await delivered).finished(); await renderSettled(page);
    assert.equal(await byId(page, "chat").getAttribute("data-session-id"), b.ref.id);
    assert.equal(await byId(page, "session-title").textContent(), "导航会话乙");
    assert.equal(await page.locator('[data-testid="session-item"].active').getAttribute("title"), b.sessionFile);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("pi-pane.lastSession")), b.ref.id);
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("R7 Chrome 已持久化助手条目的工具卡片显示第二次等长 partialResult", { timeout: 90_000 }, async t => {
  assert.equal(JSON.stringify({ content: [{ type: "text", text: "进度 10%" }], details: {} }).length,
    JSON.stringify({ content: [{ type: "text", text: "进度 20%" }], details: {} }).length);
  const s = await setup(t, {
    turns: [{ segments: [{ type: "toolCall", id: "same-length", name: "pane_test_progress", arguments: {} }] }],
    fallback: { segments: [{ type: "text", text: "工具调用结束" }] },
  }, { serverOptions: fixture => ({ extraExtensions: [providerPath, progressTool], env: { ...fixture.env, PANE_TOOL_GATE: path.join(fixture.root, "progress") } }) }); if (!s) return;
  const { page, fixture } = s;
  await newSession(page, fixture);
  await send(page, "工具进度回归");
  await until(async () => {
    const view = await sessionView(s);
    return view.entries.some(entry => entry.message?.role === "assistant" && entry.message.content.some(block => block.id === "same-length"));
  });
  const card = byId(page, "assistant-message").locator('[data-testid="tool-card"][data-tool-call-id="same-length"]');
  await card.locator(".tool-head").click();
  await card.getByText("进度 10%", { exact: true }).waitFor();
  const disk = await readSession((await sessionView(s)).sessionFile);
  assert.ok(disk.entries.some(entry => entry.message?.role === "assistant" && entry.message.content.some(block => block.id === "same-length")), "工具调用必须已落盘，避免仅测 streaming 分支");
  await writeFile(path.join(fixture.root, "progress.next"), "");
  await card.getByText("进度 20%", { exact: true }).waitFor();
  assert.equal(await card.getByText("进度 10%", { exact: true }).count(), 0);
  assert.equal(await card.locator(".tool-state").textContent(), "运行中", "第二次 partial 必须在最终结果前可见");
  await writeFile(path.join(fixture.root, "progress.finish"), "");
  await idle(s);
  await page.getByText("工具调用结束", { exact: true }).waitFor();
});

test("R9 Chrome 返回同一会话的新导航不受旧快照屏障影响", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("新导航的完整回复")); if (!s) return;
  const { page } = s;
  const b = await create(s, "导航代次乙");
  const a = await create(s, "导航代次甲");
  const other = await secondTab(s);
  const gate = latch(); let captured = false;
  const pattern = `**/api/sessions/${a.ref.id}/snapshot`;
  await page.route(pattern, async route => {
    const response = await route.fetch(); captured = true;
    await gate.promise; await route.fulfill({ response });
  });
  try {
    s.server.sessions.records.get(a.ref.id).model.emit({ type: "resync" });
    await until(() => captured);
    await choose(page, b); await choose(page, a);
    await send(other, "返回同一会话后产生的消息");
    await idle(s, other);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="user-message"]')].some(el => el.textContent === "返回同一会话后产生的消息"), null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 2 && !document.querySelector('[data-testid="streaming"]'));
    const delivered = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${a.ref.id}/snapshot`));
    gate.release(); await (await delivered).finished(); await renderSettled(page);
    assert.equal(await byId(page, "chat").getAttribute("data-session-id"), a.ref.id);
    assert.deepEqual((await byId(page, "assistant-message").allTextContents()).map(text => text.trim()), ["新导航的完整回复", "新导航的完整回复"]);
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("R9 Chrome 旧会话快照挂起期间，新导航仍收到另一会话的最终事件", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("屏障外的完整回复")); if (!s) return;
  const { page } = s;
  const b = await create(s, "屏障会话乙");
  const a = await create(s, "屏障会话甲");
  const other = await secondTab(s); await choose(other, b);
  const gate = latch(); let captured = false;
  const pattern = `**/api/sessions/${a.ref.id}/snapshot`;
  await page.route(pattern, async route => {
    const response = await route.fetch(); captured = true;
    await gate.promise; await route.fulfill({ response });
  });
  try {
    s.server.sessions.records.get(a.ref.id).model.emit({ type: "resync" });
    await until(() => captured);
    await choose(page, b);
    await send(other, "旧屏障期间的新消息");
    const view = await idle(s, other);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="user-message"]')].some(el => el.textContent === "旧屏障期间的新消息"));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 2 && !document.querySelector('[data-testid="streaming"]'));
    const delivered = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${a.ref.id}/snapshot`));
    gate.release(); await (await delivered).finished(); await renderSettled(page);
    assert.equal(await byId(page, "chat").getAttribute("data-session-id"), b.ref.id);
    assert.equal(await byId(page, "session-title").textContent(), "屏障会话乙");
    const disk = (await readSession(view.sessionFile)).entries.filter(entry => entry.message?.role === "assistant").map(entry => entry.message.content.map(block => block.text ?? "").join(""));
    assert.deepEqual((await byId(page, "assistant-message").allTextContents()).map(text => text.trim()), disk);
    assert.equal(disk.length, 2);
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});
