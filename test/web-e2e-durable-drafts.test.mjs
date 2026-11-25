// 清出的草稿在“可能丢失”的路径上不丢：服务端正常关停（#10），停止或关闭的结果没有交到发起的页面（#11：刷新、关闭、
// 断网超过重试期限、服务端重启），两个标签页、取回后又刷新都只放回一次。草稿放回原会话的输入框，服务端副本取回后删除。
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
const text = value => [{ type: "text", text: value }];
const hasUser = (view, value) => view.entries.some(entry => entry.message?.role === "user" && entry.message.content.some(block => block.text === value));
const restartErrors = [/status of 401 \(Unauthorized\)/, /net::ERR_INTERNET_DISCONNECTED/, /net::ERR_CONNECTION_REFUSED/, /WebSocket connection to .* failed/];

async function dispatch(page, value, button) {
  const editor = byId(page, "composer");
  await editor.fill(value);
  await editor.press("Escape");
  const action = button ? byId(page, button) : page.locator('[data-testid="send"],[data-testid="steer"]');
  await until(() => action.isEnabled(), 15_000);
  if (button) await action.click(); else await editor.press("Enter");
}
async function cleared(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="composer"]')?.textContent === "" && !document.querySelector('[data-testid="composer"]').hasAttribute("aria-busy"));
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
const toasts = async page => (await byId(page, "toast").allTextContents()).join("\n");
const keysWith = (page, prefix) => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), prefix);
const saved = (s, id) => s.server.sessions.outbox.list(id);

/** 开始一轮挂起的回复，排入一条带图片的 follow-up 和一条纯文字 follow-up；返回两条草稿。 */
async function queueDrafts(s) {
  const { page, fixture } = s;
  await fixture.setScript({ fallback: { segments: [{ type: "text", text: "等待停止" }, { type: "hang" }] } });
  const hangs = (await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "hang").length;
  await dispatch(page, "挂起的回合");
  await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "hang").length > hangs);
  const editor = byId(page, "composer");
  const original = png(5, 1, 1);
  const assetId = "sha256-" + createHash("sha256").update(original).digest("hex");
  await editor.fill("图片之前 ");
  await byId(page, "image-input").setInputFiles({ name: "queued.png", mimeType: "image/png", buffer: original });
  await editor.locator(".chip[data-asset-id]").waitFor();
  await editor.evaluate(el => { el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.insertText(" 图片之后");
  const image = await draftNodes(page);
  assert.deepEqual(image.map(node => node.type), ["text", "image", "text"]);
  assert.equal(image[1].assetId, assetId);
  await byId(page, "follow-up").click();
  await cleared(page);
  await dispatch(page, "排队的纯文字", "follow-up");
  await cleared(page);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="queue"] .queued').length === 2);
  return [image, text("排队的纯文字")];
}
/** 放回后输入框中的内容：放回的草稿按顺序放在现有内容之前。 */
const joined = (drafts, existing = []) => prependDrafts(drafts, existing);

async function restart(s) {
  const origin = s.server.origin;
  await s.context.setOffline(true);
  await s.server.close(); s.server = null;
  s.server = await startWebServer(s.fixture, { ...serverOptions(), port: Number(new URL(origin).port) });
  await s.context.setOffline(false);
  const paired = observePage(await s.context.newPage()); s.pages.push(paired); paired.setDefaultTimeout(15_000);
  await paired.goto(`${origin}/#code=${s.server.auth.issuePairCode()}`);
  await byId(paired, "sidebar").waitFor();
  return paired;
}
/** 扣住某会话的停止或关闭响应：服务端照常执行，结果不交给页面。之后同一 requestId 的续取放行。 */
async function holdFirst(page, id, kind) {
  const state = { body: null, result: null };
  await page.route(`**/api/sessions/${id}/control`, async route => {
    const body = route.request().postDataJSON();
    if (body.command.type !== kind || state.body) return route.continue();
    state.body = body;
    state.result = await (await route.fetch()).json();
    // 不响应：页面刷新或关闭时浏览器取消该请求。
  });
  return state;
}

test("#10 Chrome Ctrl+C 关停服务端时排队的草稿（含图片）保存，重启并重新配对后放回原会话并提示，双标签页和刷新都不重复", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: restartErrors }); if (!s) return;
  const b = await create(s, "关停乙");
  const a = await create(s, "关停甲");
  const drafts = await queueDrafts(s);
  await byId(s.page, "composer").fill("关停前的输入");
  await page_wait(s.page, a.ref.id);
  const before = (await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length;

  const paired = await restart(s);
  const [record] = await saved(s, a.ref.id);
  assert.equal(record.reason, "shutdown");
  assert.deepEqual(record.drafts, drafts.map(nodes => ({ nodes, uncertain: false })), "关停时清出的原草稿（含图片节点）保存在服务端");
  assert.equal((await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length, before, "排队的消息没有发送");

  // 第二个标签页先打开同一会话：两页串行取回，只放回一次。
  const other = observePage(await s.context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
  await other.goto(s.server.origin); await byId(other, "sidebar").waitFor();
  await Promise.all([choose(paired, a), choose(other, a)]);
  const restored = await until(async () => {
    const [mine, theirs] = await Promise.all([draftNodes(paired), draftNodes(other)]);
    return (mine.some(node => node.type === "image") || theirs.some(node => node.type === "image")) && { mine, theirs };
  });
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  const holder = restored.mine.some(node => node.type === "image") ? paired : other;
  const want = joined(drafts, text("关停前的输入"));
  assert.deepEqual(await draftNodes(holder), want, "放回的草稿在关停前的输入之前");
  assert.match(await toasts(holder), /服务端关闭前排队的消息已放回输入框/);
  assert.deepEqual(await keysWith(holder, "pi-pane.ack."), [], "服务端副本删除后移除待删除登记");

  // 取回后刷新、切换会话：草稿保留，不再放回第二次。
  for (const page of [paired, other]) { await page.reload(); await choose(page, a); }
  await until(async () => JSON.stringify(await draftNodes(paired)) === JSON.stringify(want));
  assert.deepEqual(await draftNodes(other), want);
  await choose(paired, b); await choose(paired, a);
  assert.deepEqual(await draftNodes(paired), want);
  assert.doesNotMatch(await toasts(paired), /服务端关闭前/);
});

/** 输入框的现有内容写入草稿存储后再继续。 */
async function page_wait(page, id) {
  await page.waitForFunction(key => localStorage.getItem(key) !== null, `pi-pane.draft.${id}`);
}

test("#11 Chrome 停止已执行、结果返回前刷新发起页面：新页面用同一 requestId 续取，放回后删除服务端副本，再刷新不重复", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const a = await create(s, "刷新甲");
  const drafts = await queueDrafts(s);
  const held = await holdFirst(page, a.ref.id, "stop");
  await byId(page, "stop").click();
  await until(() => held.result);
  assert.equal(held.result.status, "done");
  assert.equal((await saved(s, a.ref.id))[0].id, held.body.requestId, "清出时即以 requestId 保存");
  assert.equal((await keysWith(page, "pi-pane.stopflight.")).length, 1, "发起前记下在途请求");
  const resumed = page.waitForRequest(request => request.url().endsWith(`/${a.ref.id}/control`) && request.postDataJSON().requestId === held.body.requestId);
  await page.reload();
  await resumed;
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
  assert.deepEqual(await draftNodes(page), joined(drafts));
  assert.match(await toasts(page), /排队中的消息已放回输入框/);
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  await until(async () => (await keysWith(page, "pi-pane.stopflight.")).length + (await keysWith(page, "pi-pane.ack.")).length === 0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
  assert.deepEqual(await draftNodes(page), joined(drafts), "取回后又刷新：草稿只有一份");
});

test("#11 Chrome 两个标签页打开同一会话，发起关闭的页面在结果返回前关闭：另一页取回并删除服务端副本", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [/status of 409 \(Conflict\)/] }); if (!s) return;
  const { page, context } = s;
  const a = await create(s, "双页甲");
  const drafts = await queueDrafts(s);
  const other = observePage(await context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
  await other.goto(s.server.origin); await byId(other, "sidebar").waitFor();
  await choose(other, a);
  const held = await holdFirst(page, a.ref.id, "close");
  await page.getByTitle("停止 pi 进程并关闭会话", { exact: true }).click();
  await until(() => held.result);
  assert.equal(held.result.status, "done");
  await other.waitForTimeout(2500);
  assert.deepEqual(await draftNodes(other), [], "发起的页面仍在等待时不取走");
  s.pages.splice(s.pages.indexOf(page), 1);
  await page.close({ runBeforeUnload: false });
  await byId(other, "composer").locator(".chip[data-asset-id]").waitFor({ timeout: 15_000 });
  assert.deepEqual(await draftNodes(other), joined(drafts));
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  assert.deepEqual(await keysWith(other, "pi-pane.stopflight."), []);
});

test("#11 Chrome 停止的响应因断网超过重试期限而放弃，网络恢复后续取原结果并放回", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [/net::ERR_INTERNET_DISCONNECTED/] }); if (!s) return;
  const { page } = s;
  // 页面计时使用可快进的时钟，跳过 120 秒的网络重试期限。
  await page.clock.install();
  await page.reload(); await byId(page, "sidebar").waitFor();
  const a = await create(s, "断网甲");
  const drafts = await queueDrafts(s);
  let offline = true; let attempts = 0; let result;
  await page.route(`**/api/sessions/${a.ref.id}/control`, async route => {
    if (route.request().postDataJSON().command.type !== "stop" || !offline) return route.continue();
    attempts++;
    // 服务端执行并返回结果，响应在网络上丢失。
    result ??= await (await route.fetch()).json();
    await route.abort("internetdisconnected");
  });
  await byId(page, "stop").click();
  await until(() => result && attempts >= 1);
  assert.equal(result.status, "done");
  await page.clock.fastForward("02:05");
  await until(async () => /这次操作可能已经执行/.test(await toasts(page)), 15_000);
  assert.deepEqual(await draftNodes(page), [], "放弃重试时结果未知，不放回");
  assert.equal((await keysWith(page, "pi-pane.stopflight.")).length, 1, "保留在途请求");
  offline = false;
  await page.clock.fastForward("00:06");
  await byId(page, "composer").locator(".chip[data-asset-id]").waitFor();
  assert.deepEqual(await draftNodes(page), joined(drafts));
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  assert.deepEqual(await keysWith(page, "pi-pane.stopflight."), []);
});

test("#11 Chrome 停止已执行、发起页面关闭后服务端重启：重新打开会话时按 requestId 取回服务端保存的草稿", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: [...restartErrors, /status of 409 \(Conflict\)/] }); if (!s) return;
  const { page } = s;
  const a = await create(s, "重启甲");
  const drafts = await queueDrafts(s);
  const held = await holdFirst(page, a.ref.id, "stop");
  await byId(page, "stop").click();
  await until(() => held.result);
  s.pages.splice(s.pages.indexOf(page), 1);
  await page.close({ runBeforeUnload: false });
  const paired = await restart(s);
  assert.equal((await saved(s, a.ref.id))[0].id, held.body.requestId);
  await choose(paired, a);
  await byId(paired, "composer").locator(".chip[data-asset-id]").waitFor();
  assert.deepEqual(await draftNodes(paired), joined(drafts));
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  assert.deepEqual(await keysWith(paired, "pi-pane.stopflight."), []);
});
