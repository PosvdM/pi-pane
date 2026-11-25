// 服务端保存的清出草稿在 Chrome 中的取回（#10、#11）：服务端记录是唯一的权威副本。发起停止的页面收到结果后领取并直接放回；
// 结果没有交到页面、服务端关停等异步路径上，记录显示在该会话所有标签页的待取回条中，由用户点“放回输入框”领取，只有一个领取者拿到。
// 另一标签页没有未保存的编辑时，从草稿存储重新读取并显示，不写回，不会用旧内容覆盖放回的草稿。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { png } from "../experiments/p0/b-bridge/images.mjs";
import { prependDrafts } from "../packages/web/src/lib/draft.ts";
import { providerPath, until } from "./fixtures/helpers.mjs";
import { openPaired, startWebServer } from "./fixtures/browser.mjs";
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toasts = async page => (await byId(page, "toast").allTextContents()).join("\n");
const saved = (s, id) => s.server.sessions.outbox.list(id);
const stored = (page, id) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]"), `pi-pane.draft.${id}`);
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

test("#10 Chrome 服务端关停时排队的草稿（含图片）保存，重启后两个标签页都显示待取回条；一页放回后另一页的条消失、草稿同步显示且不被覆盖，刷新不重复", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions, allowedErrors: restartErrors }); if (!s) return;
  const b = await create(s, "关停乙");
  const a = await create(s, "关停甲");
  const drafts = await queueDrafts(s);
  await byId(s.page, "composer").fill("关停前的输入");
  await s.page.waitForFunction(key => localStorage.getItem(key) !== null, `pi-pane.draft.${a.ref.id}`);
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
    assert.deepEqual(await draftNodes(page), text("关停前的输入"), "异步路径不自动放回");
  }
  await rows(paired).first().getByTestId("saved-draft-restore").click();
  const want = prependDrafts(drafts, text("关停前的输入"));
  await until(async () => same(await draftNodes(paired), want));
  assert.match(await toasts(paired), /排队中的消息已放回输入框/);
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  // 另一页：收到变更通知后条消失；没有未保存的编辑，从草稿存储重新读取并显示，不写回。
  await until(async () => await rows(other).count() === 0 && await rows(paired).count() === 0);
  await until(async () => same(await draftNodes(other), want));
  await other.waitForTimeout(800);
  assert.deepEqual(await stored(paired, a.ref.id), want, "另一页没有用放回前的旧内容覆盖草稿存储");
  assert.doesNotMatch(await toasts(other), /已放回输入框/, "提示只出现在放回的一页");

  // 另一页随后编辑：编辑基于同步后的内容，放回的草稿保留，并同步回放回的一页。
  await typeAtEnd(other, "，另一页补充");
  const edited = prependDrafts(drafts, text("关停前的输入，另一页补充"));
  await until(async () => same(await stored(paired, a.ref.id), edited));
  await until(async () => same(await draftNodes(paired), edited));

  // 刷新、切换会话：草稿保留，没有待取回条，也不会再放回一次。
  for (const page of [paired, other]) { await page.reload(); await choose(page, a); }
  await until(async () => same(await draftNodes(paired), edited));
  assert.deepEqual(await draftNodes(other), edited);
  await choose(paired, b); await choose(paired, a);
  assert.deepEqual(await draftNodes(paired), edited);
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

test("Chrome 停止成功时发起页领取并直接放回，同一会话的另一页同步显示；普通草稿在未编辑的另一页同步且不被旧内容覆盖", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const a = await create(s, "同步甲");
  const other = await tab(s);
  await choose(other, a);

  // 普通草稿：一页编辑后，另一页（没有未保存的编辑）重新读取并显示，不写回。
  await byId(page, "composer").fill("第一页的草稿");
  await until(async () => same(await draftNodes(other), text("第一页的草稿")));
  await typeAtEnd(other, "，第二页补充");
  await until(async () => same(await draftNodes(page), text("第一页的草稿，第二页补充")));
  await page.waitForTimeout(800);
  assert.deepEqual(await stored(page, a.ref.id), text("第一页的草稿，第二页补充"));
  await byId(page, "composer").fill("");
  await until(async () => same(await draftNodes(other), []));

  const drafts = await queueDrafts(s);
  await byId(other, "composer").fill("另一页的输入");
  await until(async () => same(await draftNodes(page), text("另一页的输入")));
  let shown = false;
  const watch = setInterval(() => { void rows(other).count().then(n => { if (n) shown = true; }, () => {}); }, 20);
  await byId(page, "stop").click();
  const want = prependDrafts(drafts, text("另一页的输入"));
  await until(async () => same(await draftNodes(page), want));
  assert.match(await toasts(page), /排队中的消息已放回输入框/);
  assert.equal(await rows(page).count(), 0, "发起页直接放回，不显示待取回条");
  await until(async () => same(await draftNodes(other), want));
  await until(async () => (await saved(s, a.ref.id)).length === 0);
  await until(async () => await rows(other).count() === 0);
  clearInterval(watch);
  t.diagnostic(`另一页短暂显示过待取回条：${shown}`);
  await other.waitForTimeout(800);
  assert.deepEqual(await stored(page, a.ref.id), want, "另一页没有写回旧内容");
});

test("Chrome 一页停止、结果返回期间另一页连续打字：保存时发现另一页已放回，两边的内容合并保留并提示；待取回条的放弃先确认，放弃后各页的条消失、输入框不变", { timeout: 150_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { serverOptions }); if (!s) return;
  const { page } = s;
  const a = await create(s, "合并甲");
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

  // 另一页开始打字，防抖期间一直有未保存的编辑；此时放行，发起页领取后把草稿写入共享的草稿存储。
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
  assert.ok(written, "发起页已领取并写入草稿存储");
  assert.deepEqual(await draftNodes(other), text(typed), "另一页有未保存的编辑，不因 storage 事件重新读取");
  await other.keyboard.insertText("完"); typed += "完";

  // 另一页保存时版本已变：与存储中的内容合并，不覆盖发起页放回的草稿；发起页随后同步显示合并结果。
  const want = prependDrafts(drafts, text(typed));
  await until(async () => same(await stored(page, a.ref.id), want));
  await until(async () => same(await draftNodes(other), want));
  await until(async () => same(await draftNodes(page), want));
  assert.match(await toasts(other), /另一页面修改了草稿，已合并/);
  assert.match(await toasts(page), /排队中的消息已放回输入框/);
  assert.deepEqual(await saved(s, a.ref.id), []);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // 放弃：再排两条，停止的结果没有交到发起页（刷新），记录留在待取回条中。
  await byId(page, "composer").fill("");
  await until(async () => same(await draftNodes(other), []));
  await queueDrafts(s);
  const stop = await holdFirst(page, a.ref.id, "stop");
  await byId(page, "stop").click();
  await until(() => stop.result);
  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.waitForFunction(id => document.querySelector('[data-testid="chat"]')?.dataset.sessionId === id, a.ref.id);
  await byId(other, "composer").fill("放弃时的输入");
  for (const p of [page, other]) await until(async () => await rows(p).count() === 1);
  await until(async () => same(await draftNodes(page), text("放弃时的输入")));

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
  for (const p of [page, other]) assert.deepEqual(await draftNodes(p), text("放弃时的输入"));
  assert.doesNotMatch(await toasts(page), /已放弃/, "提示只出现在放弃的一页");
});
