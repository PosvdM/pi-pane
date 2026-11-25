// 服务端保存的清出草稿在 Chrome 中的取回（#10、#11）：服务端记录是唯一的权威副本。发起停止的页面收到结果后领取并直接放回；
// 结果没有交到页面、服务端关停等异步路径上，记录显示在该会话所有标签页的待取回条中，由用户点“放回输入框”领取，只有一个领取者拿到。
// 输入框草稿按标签页分键，每页只写自己的键；已关闭标签页的草稿由打开同一会话的其他标签页收养。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { prependDrafts } from "../packages/web/src/lib/draft.ts";
import { providerPath, until } from "./fixtures/helpers.mjs";
import { openPaired, startWebServer } from "./fixtures/browser.mjs";
import { setup, byId, newSession, idle, sessionView, records, replyScript, sessionItem, observePage, draftKey } from "./fixtures/web-e2e.mjs";

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toasts = async page => (await byId(page, "toast").allTextContents()).join("\n");
const saved = (s, id) => s.server.sessions.outbox.list(id);
const stored = async (page, id) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]"), await draftKey(page, id));
const tabOf = page => page.evaluate(() => sessionStorage.getItem("pi-pane.tab"));
/** 模拟页面回到前台。无头 Chrome 中页面始终可见，直接派发 visibilitychange。 */
const foreground = page => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const rows = page => byId(page, "saved-draft");
async function typeAtEnd(page, value) {
  await byId(page, "composer").evaluate(el => { el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.insertText(value);
}
async function tab(s, context = s.context) {
  const page = observePage(await context.newPage()); s.pages.push(page); page.setDefaultTimeout(15_000);
  await page.goto(s.server.origin); await byId(page, "sidebar").waitFor();
  return page;
}

/** 开始一轮挂起的回复，排入一条带图片的 follow-up 和一条纯文字 follow-up；返回两条草稿。 */
async function queueDrafts(s, page = s.page) {
  const { fixture } = s;
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
  await typeAtEnd(page, " 图片之后");
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
/** 扣住某会话的停止或关闭响应：服务端照常执行，结果不交给页面。 */
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

test("#10 Chrome 服务端关停时排队的草稿（含图片）保存，重启后两个标签页都显示待取回条；一页放回后另一页的条消失、输入框不变；关闭原页后另一页回到前台时收养它的草稿，刷新不重复", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: restartErrors }); if (!s) return;
  const b = await create(s, "关停乙");
  const a = await create(s, "关停甲");
  const drafts = await queueDrafts(s);
  await byId(s.page, "composer").fill("关停前的输入");
  await s.page.waitForFunction(key => localStorage.getItem(key) !== null, await draftKey(s.page, a.ref.id));
  const before = (await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length;

  const paired = await restart(s);
  const [record] = await saved(s, a.ref.id);
  assert.equal(record.reason, "shutdown");
  assert.deepEqual(record.drafts, drafts.map(nodes => ({ nodes, uncertain: false })), "关停时清出的原草稿（含图片节点）保存在服务端");
  assert.equal((await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request").length, before, "排队的消息没有发送");

  const other = await tab(s);
  await Promise.all([choose(paired, a), choose(other, a)]);
  for (const page of [paired, other]) {
    await until(async () => await rows(page).count() === 1);
    const row = rows(page).first();
    assert.equal(await row.getAttribute("data-record-id"), record.id);
    assert.match(await row.textContent(), /服务端关闭前排队.*图片之前 \[Image #1\] 图片之后 \/ 排队的纯文字（1 张图片）/);
    assert.deepEqual(await draftNodes(page), [], "异步路径不自动放回；原页仍开着，不收养它的草稿");
  }
  await rows(paired).first().getByTestId("saved-draft-restore").click();
  const want = prependDrafts(drafts, []);
  await until(async () => same(await draftNodes(paired), want));
  assert.match(await toasts(paired), /排队中的消息已放回输入框/);
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  await until(async () => same(await stored(paired, a.ref.id), want));
  // 另一页：收到变更通知后条消失，输入框不变。
  await until(async () => await rows(other).count() === 0 && await rows(paired).count() === 0);
  assert.deepEqual(await draftNodes(other), []);
  assert.doesNotMatch(await toasts(other), /已放回输入框/, "提示只出现在放回的一页");

  // 关闭原页（它的键里是“关停前的输入”）：另一页回到前台时收养，接在本页内容之前。
  await typeAtEnd(other, "另一页的输入");
  await until(async () => same(await stored(other, a.ref.id), text("另一页的输入")));
  const originalKey = await draftKey(s.page, a.ref.id);
  await s.page.close();
  const adopted = prependDrafts([text("关停前的输入")], text("另一页的输入"));
  // 页面关闭后浏览器才释放它的锁：每次检查前都派发一次，锁释放后的第一次即收养。
  await until(async () => { await foreground(other); return same(await draftNodes(other), adopted); });
  assert.match(await toasts(other), /已关闭的标签页中这个会话的草稿已放入输入框/);
  await until(async () => same(await stored(other, a.ref.id), adopted));
  assert.equal(await other.evaluate(key => localStorage.getItem(key), originalKey), null, "收养后删除原页的键");
  await foreground(paired);
  await paired.waitForTimeout(300);
  assert.deepEqual(await draftNodes(paired), want, "已被收养的草稿不再出现在其他页");

  // 刷新、切换会话：各页的草稿保留，没有待取回条，也不会再放回一次。
  for (const page of [paired, other]) { await page.reload(); await choose(page, a); }
  await until(async () => same(await draftNodes(paired), want));
  await until(async () => same(await draftNodes(other), adopted));
  await choose(paired, b); await choose(paired, a);
  assert.deepEqual(await draftNodes(paired), want);
  assert.equal(await rows(paired).count(), 0);
});

test("#11 Chrome 停止已执行、结果返回前刷新发起页面：记录显示在待取回条中；另一独立浏览器配置也显示，两边同时放回只有一边拿到", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const a = await create(s, "刷新甲");
  const drafts = await queueDrafts(s);
  // 另一个浏览器配置：不共享 localStorage 和 Web Lock。
  const { context: profile, page: elsewhere } = await openPaired(s.browser, s.server); s.pages.push(elsewhere); elsewhere.setDefaultTimeout(15_000);
  t.after(() => profile.close().catch(() => {}));
  await choose(elsewhere, a);
  const held = await holdFirst(page, a.ref.id, "stop");
  await byId(page, "stop").click();
  await until(() => held.result);
  assert.equal(held.result.status, "done");
  assert.equal(held.result.draftsRecord, held.body.requestId, "清出时即以 requestId 保存");
  assert.equal(await rows(page).count(), 0, "发起页等待结果期间不在待取回条中显示这条记录");
  await until(async () => await rows(elsewhere).count() === 1);
  assert.match(await rows(elsewhere).first().textContent(), /停止时清出/);

  await page.reload();
  // 刷新后再撤销拦截：撤销会放行仍挂起的原请求，页面就会收到结果。
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  await until(async () => await rows(page).count() === 1);
  assert.deepEqual(await draftNodes(page), [], "刷新后不自动放回");

  // 两边的领取请求都放行到同一时刻，服务端只把内容交给一个。
  let release; const gate = new Promise(resolve => { release = resolve; });
  for (const p of [page, elsewhere]) await p.route(`**/drafts/*/claim`, async route => { await gate; await route.continue(); });
  const claims = [page, elsewhere].map(p => p.waitForResponse(response => response.url().endsWith("/claim")));
  await Promise.all([rows(page).first().getByTestId("saved-draft-restore").click(), rows(elsewhere).first().getByTestId("saved-draft-restore").click()]);
  release();
  const results = await Promise.all(claims.map(async response => (await response).json()));
  assert.deepEqual(results.map(result => result.status).sort(), ["claimed", "gone"]);
  const [winner, loser] = results[0].status === "claimed" ? [page, elsewhere] : [elsewhere, page];
  await winner.locator('[data-testid="composer"] .chip[data-asset-id]').waitFor();
  assert.deepEqual(await draftNodes(winner), prependDrafts(drafts, []));
  await until(async () => /已在其他页面放回或放弃/.test(await toasts(loser)));
  assert.deepEqual(await draftNodes(loser), []);
  await until(async () => await rows(page).count() === 0 && await rows(elsewhere).count() === 0);
  assert.deepEqual(await saved(s, a.ref.id), []);

  // 领取后又刷新：草稿只有一份，不再出现待取回条。
  await winner.unrouteAll({ behavior: "ignoreErrors" });
  await winner.reload();
  await winner.locator('[data-testid="composer"] .chip[data-asset-id]').waitFor();
  assert.deepEqual(await draftNodes(winner), prependDrafts(drafts, []));
  await winner.waitForTimeout(500);
  assert.equal(await rows(winner).count(), 0);
});

test("Chrome 两页同一会话各写各的草稿，互不覆盖，刷新后仍在；停止成功时发起页领取并直接放回，另一页不变；复制的标签页换新 tabId；关闭一页后另一页重新打开会话时收养；换行写入输入框再读出不变", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const b = await create(s, "分页乙");
  const a = await create(s, "分页甲");
  const other = await tab(s);
  await choose(other, a);
  assert.notEqual(await tabOf(page), await tabOf(other));

  const drafts = await queueDrafts(s);
  await byId(page, "composer").fill("第一页的草稿");
  await byId(other, "composer").fill("第二页的草稿");
  await until(async () => same(await stored(page, a.ref.id), text("第一页的草稿")) && same(await stored(other, a.ref.id), text("第二页的草稿")));
  await page.waitForTimeout(800);
  assert.deepEqual(await draftNodes(page), text("第一页的草稿"), "另一页的保存不影响本页");
  assert.deepEqual(await draftNodes(other), text("第二页的草稿"));
  const tabId = await tabOf(page);
  await page.reload(); await choose(page, a);
  assert.equal(await tabOf(page), tabId, "刷新沿用 tabId");
  await until(async () => same(await draftNodes(page), text("第一页的草稿")));

  // 停止：发起页领取并放回到自己的输入框之前；另一页的输入框和草稿不变。
  await byId(page, "stop").click();
  const want = prependDrafts(drafts, text("第一页的草稿"));
  await until(async () => same(await draftNodes(page), want));
  assert.match(await toasts(page), /排队中的消息已放回输入框/);
  assert.equal(await rows(page).count(), 0, "发起页直接放回，不显示待取回条");
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  await until(async () => await rows(other).count() === 0);
  await until(async () => same(await stored(page, a.ref.id), want));
  await other.waitForTimeout(500);
  assert.deepEqual(await draftNodes(other), text("第二页的草稿"));
  assert.deepEqual(await stored(other, a.ref.id), text("第二页的草稿"));

  // 复制标签页：sessionStorage 中的 tabId 与原页相同，原页仍开着，新页换一个 tabId，看不到也不覆盖原页的草稿。
  const copy = observePage(await s.context.newPage()); s.pages.push(copy); copy.setDefaultTimeout(15_000);
  await copy.addInitScript(id => { if (!sessionStorage.getItem("pi-pane.copied")) { sessionStorage.setItem("pi-pane.copied", "1"); sessionStorage.setItem("pi-pane.tab", id); } }, tabId);
  await copy.goto(s.server.origin); await byId(copy, "sidebar").waitFor();
  await choose(copy, a);
  assert.notEqual(await tabOf(copy), tabId);
  assert.deepEqual(await draftNodes(copy), []);
  await byId(copy, "composer").fill("复制页的草稿");
  await until(async () => same(await stored(copy, a.ref.id), text("复制页的草稿")));
  assert.deepEqual(await stored(page, a.ref.id), want);
  await copy.close();

  // 关闭另一页：本页重新打开该会话时收养它的草稿（复制页的也在），接在本页内容之前。
  await other.close();
  // 页面关闭后浏览器才释放它的锁：没收养到时重新打开一次。
  const has = (nodes, value) => nodes.some(node => node.type === "text" && node.text.includes(value));
  await until(async () => { await choose(page, b); await choose(page, a); await page.waitForTimeout(200); const nodes = await draftNodes(page); return has(nodes, "第二页的草稿") && has(nodes, "复制页的草稿"); });
  const all = await draftNodes(page);
  assert.ok(same(all, prependDrafts([text("第二页的草稿"), text("复制页的草稿")], want)) || same(all, prependDrafts([text("复制页的草稿"), text("第二页的草稿")], want)), "收养的草稿在前，本页内容在后");
  await until(async () => same(await stored(page, a.ref.id), all));
  assert.deepEqual(await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), `pi-pane.draft.${a.ref.id}.`), [await draftKey(page, a.ref.id)], "被收养的键已删除");

  // 末尾换行、连续换行、图片前后的换行：写进输入框再读出来完全一样。
  const newlines = [{ type: "text", text: "\n开头换行\n\n中间\n" }, { type: "image", assetId: "sha256-" + "b".repeat(64) }, { type: "text", text: "\n图片后\n\n" }];
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: await draftKey(page, b.ref.id), value: JSON.stringify(newlines) });
  await choose(page, b);
  await byId(page, "composer").locator(".chip").waitFor();
  assert.deepEqual(await draftNodes(page), newlines);
  // 不改内容，只触发一次读取和保存：保存的内容与写入前相同。
  await page.evaluate(key => localStorage.removeItem(key), await draftKey(page, b.ref.id));
  await byId(page, "composer").dispatchEvent("input");
  await until(async () => (await stored(page, b.ref.id)).length > 0);
  assert.deepEqual(await stored(page, b.ref.id), newlines);
  for (const value of [[{ type: "text", text: "末尾一个换行\n" }], [{ type: "text", text: "连续三个换行\n\n\n" }], [{ type: "image", assetId: "sha256-" + "b".repeat(64) }, { type: "text", text: "\n" }]]) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: await draftKey(page, a.ref.id), value: JSON.stringify(value) });
    await choose(page, a);
    await page.evaluate(key => localStorage.removeItem(key), await draftKey(page, a.ref.id));
    await byId(page, "composer").dispatchEvent("input");
    await until(async () => (await stored(page, a.ref.id)).length > 0);
    assert.deepEqual(await stored(page, a.ref.id), value);
    await choose(page, b);
  }
});

test("Chrome 一页停止、结果返回期间另一页连续打字：两页的内容都在、各自保存，互不覆盖；待取回条的放弃先确认，放弃后各页的条消失、输入框不变", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const a = await create(s, "并行甲");
  const other = await tab(s);
  await choose(other, a);
  const drafts = await queueDrafts(s);

  // 扣住停止的响应：服务端照常执行并保存记录，放行后发起页才领取并放回。
  let release; const gate = new Promise(resolve => { release = resolve; });
  const held = { result: null };
  await page.route(`**/api/sessions/${a.ref.id}/control`, async route => {
    if (route.request().postDataJSON().command.type !== "stop") return route.continue();
    held.result = await (await route.fetch()).json();
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(held.result) });
  });
  await byId(page, "stop").click();
  await until(() => held.result);
  assert.equal(held.result.status, "done");

  // 另一页开始打字，防抖期间一直有未保存的编辑；此时放行，发起页领取后写入它自己的键。
  let typed = "乙";
  await typeAtEnd(other, typed);
  release();
  const restored = prependDrafts(drafts, []);
  let written = false;
  for (let i = 0; i < 100 && !written; i++) {
    await other.keyboard.insertText("字"); typed += "字";
    written = same(await stored(page, a.ref.id), restored);
    if (!written) await other.waitForTimeout(60);
  }
  assert.ok(written, "发起页已领取并写入自己的草稿键");
  await other.keyboard.insertText("完"); typed += "完";
  await until(async () => same(await stored(other, a.ref.id), text(typed)));
  await other.waitForTimeout(800);
  assert.deepEqual(await draftNodes(page), restored, "放回的草稿留在发起页");
  assert.deepEqual(await stored(page, a.ref.id), restored);
  assert.deepEqual(await draftNodes(other), text(typed), "另一页的输入不受影响");
  assert.deepEqual(await stored(other, a.ref.id), text(typed));
  assert.doesNotMatch(await toasts(other), /合并/);
  assert.deepEqual(await saved(s, a.ref.id), []);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // 放弃：再排两条，停止的结果没有交到发起页（刷新），记录留在待取回条中。
  await byId(page, "composer").fill("");
  await queueDrafts(s);
  const stop = await holdFirst(page, a.ref.id, "stop");
  await byId(page, "stop").click();
  await until(() => stop.result);
  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  await byId(other, "composer").fill("放弃时的输入");
  for (const p of [page, other]) await until(async () => await rows(p).count() === 1);

  // 先确认：取消时什么都不做。
  await rows(other).first().getByTestId("saved-draft-discard").click();
  await byId(other, "choice-dialog").locator('[data-choice="cancel"]').click();
  await other.waitForTimeout(500);
  assert.equal(await rows(other).count(), 1);
  assert.equal((await saved(s, a.ref.id)).length, 1, "取消放弃时记录保留");
  // 确认后领取并丢弃：两页的条都消失，输入框不变。
  await rows(other).first().getByTestId("saved-draft-discard").click();
  await byId(other, "choice-dialog").locator('[data-choice="ok"]').click();
  await until(async () => /已放弃/.test(await toasts(other)));
  for (const p of [page, other]) await until(async () => await rows(p).count() === 0);
  assert.deepEqual(await saved(s, a.ref.id), []);
  assert.deepEqual(await draftNodes(other), text("放弃时的输入"));
  assert.deepEqual(await draftNodes(page), []);
  assert.doesNotMatch(await toasts(page), /已放弃/, "提示只出现在放弃的一页");
});
