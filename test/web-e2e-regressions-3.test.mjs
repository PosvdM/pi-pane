import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { readSession } from "../packages/server/dist/store.js";
import { providerPath, uiExtensionPath, until } from "./fixtures/helpers.mjs";
import { setup, byId, newSession, idle, sessionView, records, replyScript, secondTab, sessionItem } from "./fixtures/web-e2e.mjs";

const latch = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hasUser = (view, text) => view.entries.some(entry => entry.message?.role === "user" && entry.message.content.some(block => block.text === text));
const requests = async s => (await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request");

async function dispatch(page, text) {
  const editor = byId(page, "composer");
  await editor.fill(text);
  await editor.press("Escape");
  await until(() => page.locator('[data-testid="send"],[data-testid="steer"]').isEnabled(), 15_000);
  assert.equal(await editor.innerText(), text);
  await editor.press("Enter");
}
async function cleared(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="composer"]')?.textContent === "");
}
async function settled(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function create(s, text) {
  await newSession(s.page, s.fixture);
  await dispatch(s.page, text);
  await until(async () => {
    if (await byId(s.page, "trust-yes").isVisible()) await byId(s.page, "trust-yes").click();
    return hasUser(await sessionView(s), text);
  }, 30_000);
  const view = await idle(s);
  await cleared(s.page);
  await sessionItem(s.page, view.sessionFile).waitFor();
  return view;
}
async function choose(page, view) {
  // 对话框未将背景设为 inert；DOM 激活会话条目覆盖确认期间仍可导航的路径。
  await sessionItem(page, view.sessionFile).evaluate(el => el.click());
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, view.ref.id);
  await byId(page, "composer").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
}
async function disconnect(page) {
  await page.evaluate(() => dispatchEvent(new Event("offline")));
  await byId(page, "net-banner").waitFor();
}
async function reconnect(page) {
  const connecting = page.waitForEvent("websocket");
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await connecting;
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
}
async function draftNodes(page) {
  return byId(page, "composer").evaluate(editor => {
    const range = document.createRange(); range.selectNodeContents(editor);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const data = new DataTransfer();
    editor.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    getSelection().collapseToEnd();
    return JSON.parse(data.getData("application/x-pi-pane-draft"));
  });
}

test("Q1 Chrome 模板附图排队后停止恢复原图片节点与顺序，再发送的图片字节不变", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成")); if (!s) return;
  const { page, fixture } = s;
  await mkdir(path.join(fixture.agentDir, "prompts"));
  await writeFile(path.join(fixture.agentDir, "prompts", "pane-image.md"), "模板展开 $ARGUMENTS");
  await create(s, "加载图片模板");
  await byId(page, "composer").fill("/pane-image");
  await byId(page, "completion").getByRole("option").filter({ hasText: "/pane-image" }).waitFor();
  await fixture.setScript({
    routes: [{ when: { lastUser: "慢速图片回合" }, reply: { segments: [{ type: "text", text: "正在等待停止" }, { type: "hang" }] } }],
    fallback: { segments: [{ type: "text", text: "恢复图片已收到" }] },
  });
  await dispatch(page, "慢速图片回合");
  await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).some(row => row.kind === "hang"));
  const editor = byId(page, "composer");
  const original = png(0, 1, 1);
  const assetId = "sha256-" + hash(original);
  await editor.fill("/pane-image 图片之前 ");
  await byId(page, "image-input").setInputFiles({ name: "original.png", mimeType: "image/png", buffer: original });
  await editor.locator(".chip[data-asset-id]").waitFor();
  assert.equal(await editor.locator(".chip").getAttribute("data-asset-id"), assetId);
  await editor.evaluate(el => { el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.insertText(" 图片之后");
  const originalDraft = await draftNodes(page);
  assert.deepEqual(originalDraft.map(node => node.type), ["text", "image", "text"]);
  assert.deepEqual(originalDraft[1], { type: "image", assetId });
  const queued = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().draft?.some(node => node.assetId === assetId));
  await byId(page, "follow-up").click();
  const accepted = await queued;
  assert.equal(accepted.status(), 200);
  assert.equal((await accepted.json()).status, "accepted");
  assert.deepEqual(accepted.request().postDataJSON().draft, originalDraft);
  await cleared(page);
  await byId(page, "queue").filter({ hasText: "模板展开 图片之前 [Image #1] 图片之后" }).waitFor();
  assert.equal((await requests(s)).length, 2, "排队消息不得在停止前调用模型");
  const stopping = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().command.type === "stop");
  await byId(page, "stop").click();
  const stopped = await (await stopping).json();
  assert.equal(stopped.status, "done");
  assert.deepEqual(stopped.clearedDrafts, [originalDraft], "服务端应取回整条原始草稿，不能退化为带内部图片标记的纯文字");
  await editor.locator(".chip[data-asset-id]").waitFor();
  await idle(s);
  await byId(page, "queue").waitFor({ state: "detached" });
  assert.deepEqual(await draftNodes(page), originalDraft, "文字、图片引用和节点顺序均须恢复");
  assert.equal(await editor.locator(".chip").count(), 1);
  assert.equal(await editor.locator(".chip").getAttribute("data-asset-id"), assetId);
  assert.equal(await editor.innerText(), "/pane-image 图片之前  图片之后");
  const resending = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().draft?.some(node => node.assetId === assetId));
  await until(() => byId(page, "send").isEnabled());
  await editor.press("Escape");
  await editor.press("Enter");
  const resent = await resending;
  assert.equal(resent.status(), 200);
  assert.deepEqual(resent.request().postDataJSON().draft, originalDraft);
  await byId(page, "assistant-message").filter({ hasText: "恢复图片已收到" }).waitFor();
  const view = await idle(s);
  const users = (await readSession(view.sessionFile)).entries.filter(entry => entry.message?.role === "user" && entry.message.content.some(block => block.type === "image"));
  assert.equal(users.length, 1);
  const content = users[0].message.content;
  assert.deepEqual(content.map(block => block.type), ["text", "image", "text"]);
  assert.match(content[0].text, /^模板展开 图片之前 \[Image #1\]$/);
  assert.equal(content[2].text, " 图片之后");
  assert.equal(content[1].mimeType, "image/png");
  assert.equal(hash(Buffer.from(content[1].data, "base64")), hash(original));
  assert.equal((await requests(s)).length, 3);
});

for (const count of [1, 2]) {
  test(`Q1 Chrome 固定模板附图连续排队 ${count} 条后停止，按顺序恢复各自原图片`, { timeout: 120_000 }, async t => {
    const s = await setup(t, replyScript("预热完成")); if (!s) return;
    const { page, fixture } = s;
    const fixed = "固定模板正文，不包含参数占位符";
    await mkdir(path.join(fixture.agentDir, "prompts"));
    await writeFile(path.join(fixture.agentDir, "prompts", "pane-fixed.md"), fixed);
    await create(s, "加载固定模板");
    await byId(page, "composer").fill("/pane-fixed");
    await byId(page, "completion").getByRole("option").filter({ hasText: "/pane-fixed" }).waitFor();
    await fixture.setScript({ fallback: { segments: [{ type: "text", text: "固定模板排队等待" }, { type: "hang" }] } });
    await dispatch(page, "固定模板慢速回合");
    await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).some(row => row.kind === "hang"));
    const editor = byId(page, "composer"); const drafts = []; const ids = [];
    for (let i = 0; i < count; i++) {
      const original = png(i, 1, 1); const assetId = "sha256-" + hash(original); ids.push(assetId);
      await editor.fill(`/pane-fixed 第 ${i + 1} 张之前 `);
      await byId(page, "image-input").setInputFiles({ name: `original-${i}.png`, mimeType: "image/png", buffer: original });
      await editor.locator(".chip[data-asset-id]").waitFor();
      assert.equal(await editor.locator(".chip").getAttribute("data-asset-id"), assetId);
      await editor.evaluate(el => { el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
      await page.keyboard.insertText(` 第 ${i + 1} 张之后`);
      drafts.push(await draftNodes(page));
      const queued = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().draft?.some(node => node.assetId === assetId));
      await byId(page, "follow-up").click();
      const accepted = await queued;
      assert.equal(accepted.status(), 200);
      assert.equal((await accepted.json()).status, "accepted");
      assert.deepEqual(accepted.request().postDataJSON().draft, drafts[i]);
      await cleared(page);
      await page.waitForFunction(count => document.querySelectorAll('[data-testid="queue"] .queued').length === count, i + 1);
      assert.deepEqual(await byId(page, "queue").locator(".queued").allTextContents(), Array(i + 1).fill("排队" + fixed), "固定模板的实际队列文字相同，且不含图片标记或原参数");
    }
    assert.equal(new Set(ids).size, count, "多条草稿必须使用字节不同的图片，才能检出引用交换");
    const stopping = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().command.type === "stop");
    await byId(page, "stop").click();
    const stopped = await (await stopping).json();
    assert.equal(stopped.status, "done");
    assert.deepEqual(stopped.clearedText, Array(count).fill(fixed));
    assert.deepEqual(stopped.clearedDrafts, drafts, "相同队列文字必须按先进先出取回各自整条原草稿");
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="composer"] .chip').length === count, count);
    await idle(s);
    await byId(page, "queue").waitFor({ state: "detached" });
    assert.deepEqual(await editor.locator(".chip").evaluateAll(chips => chips.map(chip => chip.dataset.assetId)), ids);
    const expected = [];
    for (const [i, draft] of drafts.entries()) {
      if (i) expected.at(-1).text += "\n\n" + draft[0].text;
      else expected.push({ ...draft[0] });
      expected.push(...draft.slice(1).map(node => ({ ...node })));
    }
    assert.deepEqual(await draftNodes(page), expected, "输入框中的文字、空行、图片节点与顺序须全部保留");
    assert.equal((await requests(s)).length, 2, "固定模板的图片队列不得在停止前被模型消费");
  });
}

test("Q2 Chrome 标题栏关闭后两个标签页均显示未启动，随后发送可重新启动", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("会话回复")); if (!s) return;
  const { page } = s;
  const before = await create(s, "关闭状态同步");
  const other = await secondTab(s);
  for (const tab of [page, other]) {
    await byId(tab, "model-button").waitFor();
    await settled(tab);
  }
  const queries = [];
  for (const tab of [page, other]) tab.on("response", response => {
    if (response.url().endsWith("/query")) queries.push(response);
  });
  const closing = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().command.type === "close");
  await page.getByTitle("停止 pi 进程并关闭会话", { exact: true }).click();
  assert.equal((await (await closing).json()).status, "done");
  for (const tab of [page, other]) {
    await tab.getByText("未启动（发送消息后启动 pi）", { exact: true }).waitFor();
    assert.equal(await byId(tab, "model-button").count(), 0);
    assert.equal(await byId(tab, "thinking-button").count(), 0);
    assert.equal(await tab.getByTitle("停止 pi 进程并关闭会话", { exact: true }).count(), 0);
    assert.equal((await sessionView(s, tab)).hosted, false);
  }
  assert.equal(s.server.sessions.records.get(before.ref.id).handle, undefined);
  for (const response of queries) assert.notEqual((await response.json()).error, "notHosted");
  const text = "关闭后重新启动";
  await dispatch(page, text);
  await until(async () => hasUser(await sessionView(s), text), 30_000);
  await cleared(page);
  const after = await idle(s);
  for (const tab of [page, other]) {
    await byId(tab, "model-button").waitFor();
    assert.equal(await tab.getByText("未启动（发送消息后启动 pi）", { exact: true }).count(), 0);
    assert.equal((await sessionView(s, tab)).hosted, true);
  }
  assert.equal(after.sessionFile, before.sessionFile);
  assert.ok(hasUser(await readSession(after.sessionFile), text));
  assert.equal((await requests(s)).filter(row => row.lastUser === text).length, 1);
});

for (const kind of ["restart", "close"]) {
  test(`Q3 Chrome ${kind} 确认期间导航后不得向另一会话提交强制请求`, { timeout: 90_000 }, async t => {
    // 模拟的写者状态不明或保活确认响应使用 409，Chrome 会记录该拒绝响应。
    const s = await setup(t, replyScript("准备完成"), { allowedErrors: [/status of 409 \(Conflict\)/] }); if (!s) return;
    const { page } = s;
    const b = await create(s, "确认归属乙");
    const a = await create(s, "确认归属甲");
    if (kind === "restart") {
      // 仅注入异常生命周期状态；确认与导航仍经过真实浏览器及控制入口。
      s.server.sessions.records.get(a.ref.id).model.interrupt("pi", "写者状态不明的回归现场");
      await byId(page, "interrupted").waitFor();
    }
    const controls = [];
    const pattern = "**/api/sessions/*/control";
    await page.route(pattern, async route => {
      const body = route.request().postDataJSON();
      controls.push({ url: route.request().url(), body });
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(kind === "restart"
        ? { error: "writerUnknown", message: "写者状态不明，需要 assumeNoWriter" }
        : { error: "holdsConfirmation", message: "会话仍有保活原因，请确认关闭" }) });
    });
    try {
      if (kind === "restart") await byId(page, "interrupted").getByRole("button", { name: "重启", exact: true }).click();
      else await page.getByTitle("停止 pi 进程并关闭会话", { exact: true }).click();
      const dialog = byId(page, "choice-dialog");
      await dialog.waitFor();
      assert.equal(controls.length, 1);
      assert.equal(controls[0].body.command.type, kind);
      assert.ok(controls[0].url.endsWith(`/api/sessions/${a.ref.id}/control`));
      await choose(page, b);
      assert.equal(await dialog.locator('[data-choice="ok"]').textContent(), kind === "restart" ? "确认重启" : "关闭");
      await dialog.locator('[data-choice="ok"]').click();
      await dialog.waitFor({ state: "detached" });
      await settled(page);
      assert.equal(await byId(page, "chat").getAttribute("data-session-id"), b.ref.id);
      assert.equal(controls.length, 1, "原会话确认不得在导航后发起第二次控制请求");
      assert.equal(controls.some(({ body }) => body.command.assumeNoWriter || body.command.confirmHolds), false);
      assert.equal((await sessionView(s)).hosted, true);
      assert.equal((await requests(s)).length, 2);
    } finally { await page.unrouteAll({ behavior: "wait" }); }
  });
}

test("Q4 Chrome 两次重连快照乱序时，离线期间别页已回答的信任询问不复活", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("准备完成")); if (!s) return;
  const { page, fixture } = s;
  await create(s, "信任乱序现场");
  const other = await secondTab(s);
  await settled(page);
  await disconnect(page);
  const project = path.join(fixture.root, "pending-project");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(path.join(project, ".pi", "settings.json"), "{}");
  const decision = s.server.trust.request(project);
  await byId(other, "trust-dialog").waitFor();
  const pending = s.server.trust.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].cwd, project);
  assert.equal(await byId(page, "trust-dialog").count(), 0, "A 必须未收到询问推送，保持两个快照发起时相同的实时变更版本");
  const oldGate = latch(); const newGate = latch();
  const snapshots = [];
  const pattern = "**/api/trust";
  await page.route(pattern, async route => {
    const response = await route.fetch();
    const body = await response.json();
    const index = snapshots.length; snapshots.push(body);
    if (index === 0) await oldGate.promise;
    else if (index === 1) await newGate.promise;
    await route.fulfill({ response });
  });
  try {
    await reconnect(page);
    await until(() => snapshots.length === 1);
    assert.deepEqual(snapshots[0].requests.map(request => request.id), [pending[0].id]);
    await disconnect(page);
    await byId(other, "trust-yes").click();
    await byId(other, "trust-dialog").waitFor({ state: "detached" });
    assert.deepEqual(await decision, { trusted: true, remember: false });
    assert.deepEqual(s.server.trust.list(), []);
    await reconnect(page);
    await until(() => snapshots.length === 2);
    assert.deepEqual(snapshots[1], { requests: [] });
    const freshDelivered = page.waitForResponse(response => response.url().endsWith("/api/trust"));
    newGate.release(); await (await freshDelivered).finished(); await settled(page);
    assert.equal(await byId(page, "trust-dialog").count(), 0);
    const oldDelivered = page.waitForResponse(response => response.url().endsWith("/api/trust"));
    oldGate.release(); await (await oldDelivered).finished(); await settled(page);
    assert.equal(snapshots.length, 2, "旧快照应按同步代次丢弃，不能触发额外快照掩盖复活");
    assert.equal(await byId(page, "trust-dialog").count(), 0, "最后抵达的旧询问不能覆盖新连接的空快照");
    assert.equal(await byId(other, "trust-dialog").count(), 0);
  } finally {
    oldGate.release(); newGate.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("对话框 Chrome 连续五次在 editor 出现后立即填写并提交，日志保留填写值", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("准备完成"), {
    serverOptions: fixture => ({ extraExtensions: [providerPath, uiExtensionPath], env: { ...fixture.env, PANE_UI_LOG: path.join(fixture.root, "ui.jsonl") } }),
  }); if (!s) return;
  const { page, fixture } = s;
  await create(s, "立即编辑回归");
  await byId(page, "composer").fill("/pane-dialogs");
  await byId(page, "completion").getByRole("option").filter({ hasText: "/pane-dialogs" }).waitFor();
  const expected = [];
  for (let i = 0; i < 5; i++) {
    await dispatch(page, "/pane-dialogs");
    await byId(page, "ui-option").filter({ hasText: /^绿$/ }).click();
    await byId(page, "ui-confirm").click();
    const name = `立即名称 ${i + 1}`; const text = `立即填写 ${i + 1}\n不得被预填覆盖`;
    await byId(page, "ui-input").fill(name);
    await byId(page, "ui-submit").click();
    // textarea 的自动等待仅等待 editor 出现；不插入网络空闲、动画帧或预填值稳定窗口。
    await byId(page, "ui-dialog").locator("textarea").fill(text);
    await byId(page, "ui-submit").click();
    await byId(page, "ui-dialog").waitFor({ state: "detached" });
    expected.push({ method: "select", result: "绿" }, { method: "confirm", result: true }, { method: "input", result: name }, { method: "editor", result: text });
    await until(async () => (await records(path.join(fixture.root, "ui.jsonl"))).length === expected.length);
    assert.deepEqual(await records(path.join(fixture.root, "ui.jsonl")), expected);
    await cleared(page);
    await idle(s);
  }
  assert.equal((await requests(s)).length, 1, "对话框命令不得送入模型");
});
