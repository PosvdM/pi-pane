import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSession } from "../packages/server/dist/store.js";
import { providerPath, until } from "./fixtures/helpers.mjs";
import { setup, byId, newSession, idle, sessionView, records, replyScript, secondTab, sessionItem } from "./fixtures/web-e2e.mjs";

const conflictErrors = [/status of 409 \(Conflict\)/];
const webUi = fileURLToPath(new URL("./fixtures/web-ui.ts", import.meta.url));
const latch = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const hasUser = (view, text) => view.entries.some(entry => entry.message?.role === "user" && entry.message.content.some(block => block.text === text));
const requests = async s => (await records(s.fixture.env.FAKE_REQUEST_LOG)).filter(row => row.kind === "request");

// 只等待本次发送可用，不把已有的托管标志误认为本次发送完成。
async function dispatch(page, text, button) {
  const editor = byId(page, "composer");
  await editor.fill(text);
  await editor.press("Escape");
  const action = button ? byId(page, button) : page.locator('[data-testid="send"],[data-testid="steer"]');
  await until(() => action.isEnabled(), 15_000);
  assert.equal(await editor.innerText(), text, "提交前输入不得被草稿初始化覆盖");
  if (button) await action.click(); else await editor.press("Enter");
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
  try {
    await until(async () => {
      if (await byId(s.page, "trust-yes").isVisible()) await byId(s.page, "trust-yes").click();
      return hasUser(await sessionView(s), text);
    }, 30_000);
  } catch (error) {
    console.error("会话准备失败", JSON.stringify({ view: await sessionView(s), requests: await requests(s), page: await s.page.locator("body").innerText(), trust: s.server.trust.list() }));
    throw error;
  }
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
function responseFor(page, predicate) {
  return page.waitForResponse(response => response.url().endsWith("/control") && predicate(response.request().postDataJSON()));
}

for (const [button, delivery, kind] of [["follow-up", "followUp", "排队"], [undefined, "steer", "追加"]]) {
  test(`N1 Chrome 运行中的提示模板通过${kind}送达，展开后在当前回合结束后执行`, { timeout: 90_000 }, async t => {
    const s = await setup(t, replyScript("预热完成")); if (!s) return;
    const { page, fixture } = s;
    // 用户模板从隔离 agentDir/prompts 发现，不需要授予项目资源信任。
    await mkdir(path.join(fixture.agentDir, "prompts"));
    await writeFile(path.join(fixture.agentDir, "prompts", "pane-regression.md"), "---\ndescription: 浏览器回归模板\n---\n模板展开 $@\n");
    await create(s, "加载模板");
    await byId(page, "composer").fill("/pane-regression");
    await byId(page, "completion").getByRole("option").filter({ hasText: "/pane-regression" }).waitFor();
    await byId(page, "composer").fill("");
    assert.equal(await byId(page, "trust-dialog").count(), 0);
    const modelGate = path.join(fixture.root, "finish-model");
    await fixture.setScript({
      routes: [{ when: { lastUser: "当前慢速回合" }, reply: { segments: [
        { type: "text", text: "当前回合开始" }, { type: "waitForFile", file: modelGate }, { type: "text", text: "当前回合结束" },
      ] } }], fallback: { segments: [{ type: "text", text: "模板执行完成" }] },
    });
    await dispatch(page, "当前慢速回合");
    const waiting = await until(async () => (await records(fixture.env.FAKE_REQUEST_LOG)).find(row => row.kind === "waiting"));
    const raw = `/pane-regression ${delivery}`;
    const expanded = `模板展开 ${delivery}`;
    const accepted = responseFor(page, body => body.draft?.[0]?.text === raw);
    await dispatch(page, raw, button);
    const response = await accepted;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).status, "accepted", "命令必须由真实 pi 接受");
    assert.deepEqual(response.request().postDataJSON().command, { type: "prompt", delivery });
    await cleared(page);
    await byId(page, "queue").filter({ hasText: kind }).waitFor();
    assert.match(await byId(page, "queue").textContent(), new RegExp(expanded));
    const before = await records(fixture.env.FAKE_REQUEST_LOG);
    assert.equal(before.some(row => row.kind === "done" && row.request === waiting.request), false);
    assert.equal(before.some(row => row.kind === "request" && row.lastUser === expanded), false, "排队期间不得提前调用模型");
    await writeFile(modelGate, "");
    await until(async () => (await requests(s)).some(row => row.lastUser === expanded), 30_000);
    const view = await idle(s);
    await byId(page, "queue").waitFor({ state: "detached" });
    assert.ok(hasUser(await readSession(view.sessionFile), expanded), "模板展开后的消息必须落盘");
    const log = await records(fixture.env.FAKE_REQUEST_LOG);
    assert.ok(log.findIndex(row => row.kind === "done" && row.request === waiting.request) < log.findIndex(row => row.kind === "request" && row.lastUser === expanded));
    assert.equal((await requests(s)).filter(row => row.lastUser === expanded).length, 1);
    await byId(page, "assistant-message").filter({ hasText: "模板执行完成" }).waitFor();
    assert.doesNotMatch((await byId(page, "toast").allTextContents()).join("\n"), /rpcRejected|already processing/);
  });
}

test("N1 Chrome 未启动会话的 trust 被服务端拒绝且保留输入", { timeout: 60_000 }, async t => {
  const s = await setup(t, replyScript("不得调用"), { allowedErrors: [/status of 400 \(Bad Request\)/] }); if (!s) return;
  const { page } = s;
  await newSession(page, s.fixture);
  const rejected = responseFor(page, body => body.draft?.[0]?.text === "/trust");
  await dispatch(page, "/trust");
  const response = await rejected;
  assert.equal(response.status(), 400);
  assert.equal((await response.json()).error, "unsupportedCommand");
  await byId(page, "toast").filter({ hasText: "pi-pane 不支持 /trust" }).waitFor();
  assert.equal(await byId(page, "composer").innerText(), "/trust");
  assert.equal((await sessionView(s)).hosted, false);
  assert.equal((await requests(s)).length, 0);
});

test("N1 Chrome 已托管的同名 debug 扩展命令正常执行", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), {
    serverOptions: () => ({ extraExtensions: [providerPath, webUi] }),
  }); if (!s) return;
  const { page } = s;
  await create(s, "扩展预热");
  await byId(page, "composer").fill("/debug");
  await byId(page, "completion").getByRole("option").filter({ hasText: "/debug" }).waitFor();
  const accepted = responseFor(page, body => body.draft?.[0]?.text === "/debug 同名命令已执行");
  await dispatch(page, "/debug 同名命令已执行");
  const response = await accepted;
  assert.equal(response.status(), 200);
  assert.equal(response.request().postDataJSON().command.type, "prompt");
  await cleared(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="session-title"]')?.textContent === "同名命令已执行");
  assert.equal((await sessionView(s)).state.sessionName, "同名命令已执行");
  assert.equal((await requests(s)).length, 1, "扩展命令不得送到模型");
});

test("N1 Chrome quit 遇到另一标签页造成的真实 409 时保留输入", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { allowedErrors: conflictErrors }); if (!s) return;
  const { page } = s;
  await create(s, "关闭冲突");
  const other = await secondTab(s);
  const gate = latch(); let captured;
  const pattern = "**/api/sessions/*/control";
  await page.route(pattern, async route => {
    captured = route.request().postDataJSON();
    await gate.promise;
    await route.continue();
  });
  try {
    await dispatch(page, "/quit");
    await until(() => captured);
    assert.equal(captured.command.type, "close");
    await dispatch(other, "/thinking high");
    await cleared(other);
    assert.equal((await sessionView(s, other)).state.thinkingLevel, "high");
    const rejected = responseFor(page, body => body.requestId === captured.requestId);
    gate.release();
    const response = await rejected;
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).error, "revisionChanged");
    await byId(page, "toast").filter({ hasText: "会话状态已变化，请确认后重新关闭" }).waitFor();
    assert.equal(await byId(page, "composer").innerText(), "/quit");
    assert.equal((await sessionView(s)).hosted, true);
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("N2 Chrome 旧 state 查询晚于另一标签页的新思考级别时不能回退按钮", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("预热完成")); if (!s) return;
  const { page } = s;
  await create(s, "查询乱序");
  const other = await secondTab(s);
  await settled(page);
  const gate = latch(); let old; let queries = 0;
  const pattern = "**/api/sessions/*/query";
  await page.route(pattern, async route => {
    if (route.request().postDataJSON().type !== "state" || queries++ > 0) { await route.continue(); return; }
    const response = await route.fetch(); old = await response.json();
    await gate.promise; await route.fulfill({ response });
  });
  try {
    await dispatch(other, "/thinking low"); await cleared(other);
    await until(() => old);
    assert.equal(old.thinkingLevel, "low");
    await dispatch(other, "/thinking high"); await cleared(other);
    await page.waitForFunction(() => document.querySelector('[data-testid="thinking-button"]')?.textContent === "思考：high");
    assert.ok(queries >= 2, "必须有更新的 state 查询越过被挂起的旧查询");
    const delivered = page.waitForResponse(response => response.url().endsWith("/query") && response.request().postDataJSON().type === "state");
    gate.release(); await (await delivered).finished(); await settled(page);
    assert.equal(await byId(page, "thinking-button").textContent(), "思考：high");
    assert.equal((await sessionView(s)).state.thinkingLevel, "high");
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("N2 Chrome 旧 accepted 控制快照晚到不能回退新的思考级别", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("预热完成")); if (!s) return;
  const { page } = s;
  await create(s, "控制乱序");
  const other = await secondTab(s);
  const gate = latch(); let old;
  const pattern = "**/api/sessions/*/control";
  await page.route(pattern, async route => {
    const response = await route.fetch(); old = await response.json();
    await gate.promise; await route.fulfill({ response });
  });
  try {
    await dispatch(page, "/thinking low"); await until(() => old);
    assert.equal(old.status, "accepted");
    assert.equal(old.snapshot.state.thinkingLevel, "low");
    await other.waitForFunction(() => document.querySelector('[data-testid="thinking-button"]')?.textContent === "思考：low");
    await dispatch(other, "/thinking high"); await cleared(other);
    await page.waitForFunction(() => document.querySelector('[data-testid="thinking-button"]')?.textContent === "思考：high");
    assert.ok((await sessionView(s)).controlRevision > old.snapshot.controlRevision);
    const delivered = responseFor(page, () => true);
    gate.release(); await (await delivered).finished(); await cleared(page); await settled(page);
    assert.equal(await byId(page, "thinking-button").textContent(), "思考：high");
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("N3 Chrome 200 响应体 JSON 截断后用同一 requestId 重试且模型只执行一次", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("唯一回复")); if (!s) return;
  const { page } = s;
  await create(s, "截断响应预热");
  const bodies = [];
  const pattern = "**/api/sessions/*/control";
  await page.route(pattern, async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length !== 1) { await route.continue(); return; }
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const full = await response.text();
    assert.equal(JSON.parse(full).status, "accepted");
    // fulfill 交付完整 HTTP 响应中的非法 JSON，覆盖 invalidResponse 重试分支，不声称模拟 TCP 读取中断。
    const headers = { ...response.headers() }; delete headers["content-length"];
    await route.fulfill({ status: 200, headers, body: full.slice(0, Math.floor(full.length / 2)) });
  });
  try {
    const text = "响应体不完整但操作只能执行一次";
    await dispatch(page, text);
    await byId(page, "toast").filter({ hasText: "网络中断，恢复后自动核对这次操作的结果" }).waitFor();
    await until(() => bodies.length >= 2);
    await cleared(page);
    const view = await idle(s);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 2);
    for (const body of bodies) assert.deepEqual(body, bodies[0], "重试必须保留 requestId、revision、command 和 draft");
    assert.equal(new Set(bodies.map(body => body.requestId)).size, 1);
    assert.equal((await requests(s)).filter(row => row.lastUser === text).length, 1);
    const users = (await readSession(view.sessionFile)).entries.filter(entry => entry.message?.role === "user" && entry.message.content.some(block => block.text === text));
    assert.equal(users.length, 1);
    assert.equal((await byId(page, "user-message").allTextContents()).filter(value => value === text).length, 1);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});

test("N4 Chrome A 的 409 控制回包晚于导航 B 时不弹确认、不重取 B 或误发消息", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("预热完成"), { allowedErrors: conflictErrors }); if (!s) return;
  const { page } = s;
  const b = await create(s, "导航乙");
  const a = await create(s, "导航甲");
  const other = await secondTab(s);
  const forward = latch(); const deliver = latch(); let captured; let rejected;
  const text = "这条甲消息不得进入乙";
  const controls = []; const bSnapshots = [];
  page.on("request", request => {
    if (request.url().endsWith(`/api/sessions/${b.ref.id}/snapshot`)) bSnapshots.push(request.url());
  });
  const pattern = "**/api/sessions/*/control";
  await page.route(pattern, async route => {
    controls.push(route.request().postDataJSON()); captured = controls[0];
    await forward.promise;
    const response = await route.fetch();
    rejected = { status: response.status(), body: await response.json() };
    await deliver.promise; await route.fulfill({ response });
  });
  try {
    await dispatch(page, text); await until(() => captured);
    await dispatch(other, "/thinking high"); await cleared(other);
    forward.release(); await until(() => rejected);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, "revisionChanged");
    await choose(page, b); await settled(page);
    const snapshotCount = bSnapshots.length;
    const delivered = responseFor(page, body => body.requestId === captured.requestId);
    deliver.release(); await (await delivered).finished(); await settled(page);
    assert.equal(await byId(page, "chat").getAttribute("data-session-id"), b.ref.id);
    assert.equal(await byId(page, "choice-dialog").count(), 0, "不得在 B 显示 A 的重发确认");
    assert.equal(await byId(page, "composer").innerText(), "");
    assert.equal(bSnapshots.length, snapshotCount, "A 的失败续体不得 reload B");
    assert.equal(controls.length, 1, "不得把 A 的草稿重新提交到 B");
    assert.equal(hasUser(await readSession(b.sessionFile), text), false);
    assert.equal(hasUser(await readSession(a.sessionFile), text), false);
    assert.equal((await requests(s)).some(row => row.lastUser === text), false);
  } finally { forward.release(); deliver.release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("草稿初始化 Chrome 连续五次新建会话后立即 fill 和 Enter 均发送并落盘", { timeout: 120_000 }, async t => {
  const s = await setup(t, replyScript("快速发送完成")); if (!s) return;
  const { page, fixture } = s;
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    await byId(page, "new-session").click();
    await byId(page, "new-session-cwd").fill(fixture.cwd);
    const opening = page.waitForResponse(response => response.url().endsWith("/api/sessions/open"));
    await byId(page, "new-session-create").click();
    // fill 自行等待输入框进入 DOM；不等待网络横幅、托管标志或草稿恢复定时窗口。
    const text = `第 ${i + 1} 次挂载后的立即输入`;
    const sending = page.waitForRequest(request => request.url().endsWith("/control") && request.postDataJSON().draft?.[0]?.text === text);
    await byId(page, "composer").fill(text);
    await byId(page, "composer").press("Enter");
    const opened = await (await opening).json();
    await until(async () => {
      if (await byId(page, "trust-yes").isVisible()) await byId(page, "trust-yes").click();
      return hasUser(await sessionView(s), text);
    }, 30_000);
    const view = await idle(s);
    await cleared(page);
    // 启动时 pi 可以重绑定会话 id；首次提交必须指向这次 open 返回的目标。
    assert.ok((await sending).url().endsWith(`/api/sessions/${opened.ref.id}/control`));
    ids.add(view.ref.id);
    assert.ok(hasUser(await readSession(view.sessionFile), text));
    assert.equal((await requests(s)).filter(row => row.lastUser === text).length, 1);
  }
  assert.equal(ids.size, 5, "五次输入必须属于五个不同的新会话");
  assert.equal((await requests(s)).length, 5);
});

test("信任快照 Chrome 重连的旧空列表不得删除新推送的信任框，回答后正常启动", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("信任后已启动")); if (!s) return;
  const { page, fixture } = s;
  const project = path.join(fixture.root, "new-project");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(path.join(project, ".pi", "settings.json"), "{}");
  await newSession(page, { cwd: project });
  await settled(page);
  assert.equal((await sessionView(s)).hosted, false);
  assert.deepEqual(s.server.trust.list(), []);
  const gate = latch(); let old; let fresh; let gets = 0;
  const pattern = "**/api/trust";
  await page.route(pattern, async route => {
    assert.equal(route.request().method(), "GET");
    const response = await route.fetch(); const body = await response.json();
    if (++gets === 1) { old = body; await gate.promise; }
    else fresh = body;
    await route.fulfill({ response });
  });
  try {
    // 应用的 offline/online 入口关闭旧 WebSocket 并建立真实的新连接。
    const reconnecting = page.waitForEvent("websocket");
    await page.evaluate(() => dispatchEvent(new Event("offline")));
    await byId(page, "net-banner").waitFor();
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await reconnecting;
    await until(() => old);
    assert.deepEqual(old, { requests: [] });
    await page.waitForFunction(() => !document.querySelector('[data-testid="net-banner"]'));
    const text = "新项目信任竞态消息";
    await dispatch(page, text);
    await byId(page, "trust-yes").waitFor();
    const pending = s.server.trust.list();
    assert.equal(pending.length, 1, "项目 .pi/settings.json 必须触发真实 pi 资源预判");
    assert.equal(pending[0].cwd, project);
    assert.match(await byId(page, "trust-dialog").textContent(), /new-project/);
    assert.equal((await requests(s)).length, 0, "信任未回答时不得启动模型");
    gate.release();
    await until(() => fresh);
    assert.deepEqual(fresh.requests.map(request => request.id), [pending[0].id], "旧快照之后必须补取包含新询问的快照");
    await settled(page);
    assert.equal(await byId(page, "trust-dialog").count(), 1);
    await byId(page, "trust-yes").click();
    await byId(page, "assistant-message").filter({ hasText: "信任后已启动" }).waitFor();
    await byId(page, "trust-dialog").waitFor({ state: "detached" });
    const view = await idle(s);
    assert.equal(view.hosted, true);
    assert.ok(hasUser(await readSession(view.sessionFile), text));
    assert.equal((await requests(s)).length, 1);
    assert.deepEqual(s.server.trust.list(), []);
  } finally { gate.release(); await page.unrouteAll({ behavior: "wait" }); }
});
