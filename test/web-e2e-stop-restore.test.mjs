// 停止或关闭清出的草稿一律放回所属会话的输入框：不弹确认框，导航、迟到响应与服务端重启都不丢失，也不进入其他会话。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { prependDrafts } from "../packages/web/src/lib/draft.ts";
import { providerPath, until } from "./fixtures/helpers.mjs";
import { startWebServer } from "./fixtures/browser.mjs";
import { setup, byId, newSession, idle, sessionView, records, replyScript, sessionItem, observePage } from "./fixtures/web-e2e.mjs";

const webUi = fileURLToPath(new URL("./fixtures/web-ui.ts", import.meta.url));
const serverOptions = () => ({ extraExtensions: [providerPath, webUi] });
const latch = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hasUser = (view, text) => view.entries.some(entry => entry.message?.role === "user" && entry.message.content.some(block => block.text === text));
const text = value => [{ type: "text", text: value }];
/** 输入扩展把原图片草稿改写成“扩展固定正文”并追加“扩展辅助消息”，停止时原草稿归属不明。 */
const CLEARED = ["扩展辅助消息", "扩展固定正文", "确定的排队消息"];
const CLOSE_TITLE = "停止 pi 进程并关闭会话";

async function dispatch(page, value, button) {
  const editor = byId(page, "composer");
  await editor.fill(value);
  await editor.press("Escape");
  const action = button ? byId(page, button) : page.locator('[data-testid="send"],[data-testid="steer"]');
  await until(() => action.isEnabled(), 15_000);
  if (button) await action.click(); else await editor.press("Enter");
}
async function cleared(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="composer"]')?.textContent === "");
}
async function settled(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function create(s, value) {
  await newSession(s.page, s.fixture);
  await dispatch(s.page, value);
  await until(async () => {
    if (await byId(s.page, "trust-yes").isVisible()) await byId(s.page, "trust-yes").click({ timeout: 3000 }).catch(() => {}); // 询问框重渲染时由外层循环重试
    return hasUser(await sessionView(s), value);
  }, 30_000);
  const view = await idle(s);
  await cleared(s.page);
  await sessionItem(s.page, view.sessionFile).waitFor();
  return view;
}
async function choose(page, view) {
  await sessionItem(page, view.sessionFile).click();
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, view.ref.id);
  await byId(page, "composer").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
}
async function draftNodes(page) {
  return byId(page, "composer").evaluate(editor => {
    const range = document.createRange(); range.selectNodeContents(editor);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const data = new DataTransfer();
    editor.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    getSelection().collapseToEnd();
    return JSON.parse(data.getData("application/x-pi-pane-draft") || "[]");
  });
}
const stored = (page, key) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), key);
const toasts = async page => (await byId(page, "toast").allTextContents()).join("\n");
/** 该会话的待放回记录：每批一个键，按清出时间排序。 */
const pending = (page, id) => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort()
  .map(key => JSON.parse(localStorage.getItem(key)).drafts), `pi-pane.restored.${id}.`);
const NOTICE = "放回的草稿中有 1 条无法确认是否已经发送（排队期间扩展改写或追加过消息），请检查后再决定是否重发。";
async function noticeShown(page, shown = true) {
  if (shown) { await byId(page, "restored-notice").waitFor(); assert.equal(await byId(page, "restored-notice").locator("span").textContent(), NOTICE); }
  else assert.equal(await byId(page, "restored-notice").count(), 0);
}
const batch = draft => [...CLEARED.map(value => ({ nodes: text(value), uncertain: false })), { nodes: draft, uncertain: true }];

/** 在当前会话中开始一轮挂起的回复，排入一条会被扩展改写的图片草稿和一条纯文字草稿。 */
async function queueDrafts(s) {
  const { page, fixture } = s;
  await fixture.setScript({ fallback: { segments: [{ type: "text", text: "等待停止" }, { type: "hang" }] } });
  const hangs = (await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "hang").length;
  await dispatch(page, "挂起的回合");
  await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "hang").length > hangs);
  const editor = byId(page, "composer");
  const original = png(3, 1, 1);
  const assetId = "sha256-" + hash(original);
  await editor.fill("pane-queue-transform 不同辅助 图片之前 ");
  await byId(page, "image-input").setInputFiles({ name: "uncertain.png", mimeType: "image/png", buffer: original });
  await editor.locator(".chip[data-asset-id]").waitFor();
  await editor.evaluate(el => { el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.insertText(" 图片之后");
  const draft = await draftNodes(page);
  assert.deepEqual(draft.map(node => node.type), ["text", "image", "text"]);
  assert.equal(draft[1].assetId, assetId);
  const queued = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().draft?.some(node => node.assetId === assetId));
  await byId(page, "follow-up").click();
  assert.equal((await (await queued).json()).status, "accepted");
  await cleared(page);
  await dispatch(page, CLEARED[2], "follow-up");
  await cleared(page);
  await page.waitForFunction(count => document.querySelectorAll('[data-testid="queue"] .queued').length === count, CLEARED.length);
  return draft;
}
function assertStopped(result, draft) {
  assert.equal(result.status, "done");
  assert.deepEqual(result.clearedText, CLEARED);
  assert.deepEqual(result.clearedDrafts, CLEARED.map(text));
  assert.deepEqual(result.uncertainDrafts, [draft], "改写后的原图片草稿归属不明，必须交出");
}
const expected = (draft, existing = []) => prependDrafts([...CLEARED.map(text), draft], existing);

test("取回草稿 Chrome 停止后确定与归属不明的草稿都放回输入框，不弹确认框，刷新后仍在，删除后不复活", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const b = await create(s, "放回乙");
  const a = await create(s, "放回甲");
  const draft = await queueDrafts(s);
  await byId(page, "composer").fill("现有草稿");
  const stopping = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().command.type === "stop");
  await byId(page, "stop").click();
  const result = await (await stopping).json();
  assertStopped(result, draft);
  await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
  const want = expected(draft, text("现有草稿"));
  assert.deepEqual(await draftNodes(page), want, "清出的草稿按原顺序放在现有草稿之前，归属不明的排在确定的之后");
  assert.deepEqual(await stored(page, `pi-pane.draft.${a.ref.id}`), want, "放回后立即写入该会话的草稿");
  assert.deepEqual(await pending(page, a.ref.id), []);
  await settled(page);
  assert.equal(await byId(page, "choice-dialog").count(), 0, "放回草稿不经确认框");
  assert.match(await toasts(page), /排队中的消息已放回输入框/);
  await noticeShown(page);
  assert.deepEqual(await stored(page, `pi-pane.uncertain.${a.ref.id}`), [draft], "归属不明的草稿随该会话保存");
  await idle(s);

  await page.reload();
  await byId(page, "composer").waitFor();
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  assert.deepEqual(await draftNodes(page), want, "刷新页面后草稿仍在");
  await noticeShown(page);
  // R9-2：提示显示在输入框上方，不在通知列表中，只在所属会话显示。
  assert.doesNotMatch(await toasts(page), /可能已经发送/);
  await choose(page, b);
  await noticeShown(page, false);
  await choose(page, a);
  await noticeShown(page);

  // 只删除归属不明的那条、保留其他内容：提示随之消失，刷新后也不再出现。
  await byId(page, "composer").evaluate(editor => {
    const texts = [...editor.childNodes].filter(node => node.nodeType === Node.TEXT_NODE);
    const range = document.createRange();
    range.setStartBefore(texts.find(node => node.textContent.startsWith("pane-queue-transform")));
    range.setEndAfter(texts.find(node => node.textContent === " 图片之后"));
    editor.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
    document.execCommand("delete");
  });
  const kept = await draftNodes(page);
  assert.equal(kept.some(node => node.type === "image"), false);
  assert.match(kept[0].text, /确定的排队消息[\s\S]*现有草稿/);
  await noticeShown(page, false);
  assert.equal(await stored(page, `pi-pane.uncertain.${a.ref.id}`), null, "已处理掉的归属不明草稿不再计入");
  await page.waitForFunction(({ key, value }) => localStorage.getItem(key) === value, { key: `pi-pane.draft.${a.ref.id}`, value: JSON.stringify(kept) });
  await page.reload();
  await byId(page, "composer").waitFor();
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  assert.deepEqual(await draftNodes(page), kept);
  await noticeShown(page, false);

  // 明确放弃：用户在输入框中删除，与其他编辑相同；之后切换会话不会再出现。
  await byId(page, "composer").fill("");
  await page.waitForFunction(key => localStorage.getItem(key) === null, `pi-pane.draft.${a.ref.id}`);
  await noticeShown(page, false);
  await choose(page, b);
  await choose(page, a);
  assert.deepEqual(await draftNodes(page), []);
  await noticeShown(page, false);
  assert.equal((await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length, 3, "放回的草稿未自动发送");
});

for (const kind of ["stop", "close"]) {
  test(`取回草稿 Chrome A 的 ${kind} 响应晚于导航到 B：不在 B 弹框、不关闭 B 的确认框，回到 A 后放回`, { timeout: 120_000 }, async t => {
    const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [/status of 409 \(Conflict\)/] }); if (!s) return;
    const { page } = s;
    const b = await create(s, "迟到乙");
    const a = await create(s, "迟到甲");
    const draft = await queueDrafts(s);
    const deliver = latch(); let result; let bCloses = 0;
    await page.route("**/api/sessions/*/control", async route => {
      const url = route.request().url(); const body = route.request().postDataJSON();
      if (url.endsWith(`/${a.ref.id}/control`) && body.command.type === kind) {
        const response = await route.fetch();
        result = await response.json();
        await deliver.promise; await route.fulfill({ response });
      } else if (url.endsWith(`/${b.ref.id}/control`) && body.command.type === "close") {
        // B 的保活确认：在 A 的结果到达时 B 正显示一个确认框。
        bCloses++;
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "holdsConfirmation", message: "会话仍有保活原因，请确认关闭" }) });
      } else await route.continue();
    });
    try {
      if (kind === "stop") await byId(page, "stop").click();
      else await page.getByTitle(CLOSE_TITLE, { exact: true }).click();
      await until(() => result);
      assertStopped(result, draft);
      await choose(page, b);
      await byId(page, "composer").fill("乙的草稿");
      await page.getByTitle(CLOSE_TITLE, { exact: true }).click();
      const dialog = byId(page, "choice-dialog");
      await dialog.waitFor();
      assert.equal(bCloses, 1);
      const delivered = page.waitForResponse(response => response.url().endsWith(`/${a.ref.id}/control`) && response.request().postDataJSON().command.type === kind);
      deliver.release(); await (await delivered).finished(); await settled(page);
      assert.equal(await byId(page, "chat").getAttribute("data-session-id"), b.ref.id);
      assert.equal(await dialog.count(), 1, "A 的结果不得替换或关闭 B 的确认框");
      assert.match(await dialog.textContent(), /会话仍被保活/);
      assert.equal(await byId(page, "composer").innerText(), "乙的草稿", "A 的草稿不得进入 B 的输入框");
      assert.doesNotMatch(await toasts(page), /放回输入框|可能已经发送/);
      await noticeShown(page, false);
      assert.deepEqual(await pending(page, a.ref.id), [batch(draft)], "A 的草稿存入 A 的待放回记录，逐条标记归属不明");
      assert.deepEqual(await pending(page, b.ref.id), []);
      await dialog.locator('[data-choice="cancel"]').click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(bCloses, 1, "取消后不得再提交关闭");

      await choose(page, a);
      await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
      const want = expected(draft);
      assert.deepEqual(await draftNodes(page), want);
      assert.deepEqual(await stored(page, `pi-pane.draft.${a.ref.id}`), want);
      assert.deepEqual(await pending(page, a.ref.id), [], "放回后删除待放回记录");
      await noticeShown(page);
      assert.equal(await byId(page, "choice-dialog").count(), 0);
      await choose(page, b);
      assert.equal(await byId(page, "composer").innerText(), "乙的草稿");
      await noticeShown(page, false);
    } finally { deliver.release(); await page.unrouteAll({ behavior: "wait" }); }
  });
}

test("取回草稿 Chrome 待放回的草稿在服务端同端口重启、重新配对后回到原会话输入框", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), {
    serverOptions,
    allowedErrors: [/status of 401 \(Unauthorized\)/, /net::ERR_INTERNET_DISCONNECTED/, /net::ERR_CONNECTION_REFUSED/, /WebSocket connection to .* failed/],
  }); if (!s) return;
  const { page, context, fixture } = s;
  const b = await create(s, "重启乙");
  const a = await create(s, "重启甲");
  const draft = await queueDrafts(s);
  const deliver = latch(); let result;
  await page.route("**/api/sessions/*/control", async route => {
    if (!route.request().url().endsWith(`/${a.ref.id}/control`) || route.request().postDataJSON().command.type !== "stop") return route.continue();
    const response = await route.fetch();
    result = await response.json();
    await deliver.promise; await route.fulfill({ response });
  });
  try {
    await byId(page, "stop").click();
    await until(() => result);
    assertStopped(result, draft);
    await choose(page, b);
    deliver.release();
    await until(async () => (await pending(page, a.ref.id)).length === 1);
  } finally { deliver.release(); await page.unrouteAll({ behavior: "wait" }); }

  const origin = s.server.origin;
  await context.setOffline(true);
  await s.server.close(); s.server = null;
  s.server = await startWebServer(fixture, { ...serverOptions(), port: Number(new URL(origin).port) });
  await context.setOffline(false);
  // 旧页的凭证已失效，回到配对页；用新配对码在同一浏览器配置中重新配对，localStorage 与旧页共享。
  await byId(page, "pair-page").waitFor({ timeout: 30_000 });
  const paired = observePage(await context.newPage()); s.pages.push(paired); paired.setDefaultTimeout(15_000);
  await paired.goto(`${origin}/#code=${s.server.auth.issuePairCode()}`);
  await byId(paired, "sidebar").waitFor();
  await sessionItem(paired, a.sessionFile).click();
  await paired.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  await byId(paired, "composer").locator(".chip[data-asset-id]").waitFor();
  assert.deepEqual(await draftNodes(paired), expected(draft), "会话 id 取自会话文件，重启后仍对应原会话");
  assert.deepEqual(await pending(paired, a.ref.id), []);
  await noticeShown(paired);
});

test("R9-3 取回草稿 Chrome 有排队消息时在输入框执行 /quit，关闭后只留下取回的草稿", { timeout: 120_000 }, async t => {
  // 关闭运行中的会话时，abort 产生的 idle 事件触发的统计查询可能晚于进程退出，返回 409 notHosted，界面忽略该结果。
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [/status of 409 \(Conflict\)/] }); if (!s) return;
  const { page } = s;
  const a = await create(s, "退出甲");
  const draft = await queueDrafts(s);
  const closing = page.waitForResponse(response => response.url().endsWith("/control") && response.request().postDataJSON().command.type === "close");
  await dispatch(page, "/quit");
  assertStopped(await (await closing).json(), draft);
  await page.getByText("未启动（发送消息后启动 pi）", { exact: true }).waitFor();
  await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
  await settled(page);
  const want = expected(draft);
  assert.deepEqual(await draftNodes(page), want, "已执行的 /quit 不得留在输入框");
  assert.doesNotMatch(await byId(page, "composer").innerText(), /\/quit/);
  await page.waitForFunction(({ key, value }) => localStorage.getItem(key) === value, { key: `pi-pane.draft.${a.ref.id}`, value: JSON.stringify(want) });
  await noticeShown(page);
});

test("R9-1 取回草稿 Chrome 浏览器存储写入失败时草稿留在内存，只在原会话显示错误提示", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [/status of 409 \(Conflict\)/] }); if (!s) return;
  const { page } = s;
  const b = await create(s, "配额乙");
  const a = await create(s, "配额甲");
  const draft = await queueDrafts(s);
  const deliver = latch(); let result;
  await page.route("**/api/sessions/*/control", async route => {
    if (!route.request().url().endsWith(`/${a.ref.id}/control`) || route.request().postDataJSON().command.type !== "stop") return route.continue();
    const response = await route.fetch();
    result = await response.json();
    await deliver.promise; await route.fulfill({ response });
  });
  try {
    await byId(page, "stop").click();
    await until(() => result);
    assertStopped(result, draft);
    await choose(page, b);
    // 模拟配额已满：之后所有 pi-pane 草稿记录的写入都抛出 QuotaExceededError。
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (/^pi-pane\.(draft|restored|uncertain)\./.test(String(key))) throw new DOMException("模拟配额已满", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    const delivered = page.waitForResponse(response => response.url().endsWith(`/${a.ref.id}/control`) && response.request().postDataJSON().command.type === "stop");
    deliver.release(); await (await delivered).finished(); await settled(page);
    assert.deepEqual(await pending(page, a.ref.id), [], "写入失败，localStorage 中没有记录");
    assert.equal(await byId(page, "unsaved-notice").count(), 0, "错误提示不显示在 B");
    assert.equal(await byId(page, "choice-dialog").count(), 0);
  } finally { deliver.release(); await page.unrouteAll({ behavior: "wait" }); }
  await choose(page, a);
  await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
  assert.deepEqual(await draftNodes(page), expected(draft), "内存中的草稿放回原会话输入框");
  await byId(page, "unsaved-notice").waitFor();
  assert.match(await byId(page, "unsaved-notice").textContent(), /只保存到页面关闭前/);
  await noticeShown(page);
  assert.equal(await stored(page, `pi-pane.draft.${a.ref.id}`), null);
  // 切换会话后草稿仍在内存中。
  await choose(page, b);
  assert.equal(await byId(page, "unsaved-notice").count(), 0);
  await choose(page, a);
  assert.deepEqual(await draftNodes(page), expected(draft));
  await byId(page, "unsaved-notice").waitFor();
});

for (const back of [false, true]) {
  test(`取回草稿 Chrome 在输入框执行 /quit 后、关闭响应到达前切到其他会话${back ? "并在响应前切回" : ""}，回到原会话不残留 /quit`, { timeout: 120_000 }, async t => {
    const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [/status of 409 \(Conflict\)/] }); if (!s) return;
    const { page } = s;
    const b = await create(s, "切走乙");
    const a = await create(s, "切走甲");
    const draft = await queueDrafts(s);
    const deliver = latch(); let result;
    await page.route("**/api/sessions/*/control", async route => {
      if (!route.request().url().endsWith(`/${a.ref.id}/control`) || route.request().postDataJSON().command.type !== "close") return route.continue();
      const response = await route.fetch();
      result = await response.json();
      await deliver.promise; await route.fulfill({ response });
    });
    try {
      await dispatch(page, "/quit");
      await until(() => result);
      assertStopped(result, draft);
      await choose(page, b);
      assert.deepEqual(await stored(page, `pi-pane.draft.${a.ref.id}`), text("/quit"), "切走时保存了尚未完成的命令");
      if (back) {
        await choose(page, a);
        assert.equal(await byId(page, "composer").innerText(), "/quit");
      }
      const delivered = page.waitForResponse(response => response.url().endsWith(`/${a.ref.id}/control`) && response.request().postDataJSON().command.type === "close");
      deliver.release(); await (await delivered).finished(); await settled(page);
    } finally { deliver.release(); await page.unrouteAll({ behavior: "wait" }); }
    const want = expected(draft);
    if (!back) {
      assert.equal(await stored(page, `pi-pane.draft.${a.ref.id}`), null, "关闭成功后从 A 保存的草稿中删除 /quit");
      assert.deepEqual(await pending(page, a.ref.id), [batch(draft)]);
      assert.equal(await byId(page, "composer").innerText(), "", "B 的输入框不受影响");
      await choose(page, a);
    }
    await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
    await settled(page);
    assert.deepEqual(await draftNodes(page), want, "已执行的 /quit 不得留在输入框");
    await page.waitForFunction(({ key, value }) => localStorage.getItem(key) === value, { key: `pi-pane.draft.${a.ref.id}`, value: JSON.stringify(want) });
    await noticeShown(page);
    await choose(page, b);
    await choose(page, a);
    assert.deepEqual(await draftNodes(page), want);
  });
}
