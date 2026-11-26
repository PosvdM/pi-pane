// 插件会话输入框与主会话共用草稿和在途提交（ComposerDrafts.tsx、restored.ts），以及第 5 轮审查的其余场景。
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { until } from "./fixtures/helpers.mjs";
import { byId, observePage, setup } from "./fixtures/web-e2e.mjs";

const pluginDir = fileURLToPath(new URL("./fixtures/ui-plugin/", import.meta.url));
const plugin = () => globalThis.__uiPlugin;
const node = (page, id) => page.locator(`[data-node-id="${id}"]`).first();
const editor = (page) => byId(page, "plugin-editor");
const say = { fallback: { segments: [{ type: "text", text: "好的" }] } };
const value = (page) => editor(page).inputValue();

/**
 * 关闭当前标签页、新开一个配对好的标签页。关闭的页面来不及处理在途请求的结果；新标签页有新的 tabId，
 * 只能从 localStorage 里的在途记录取回原文。
 */
async function reopenTab(s) {
  const fresh = observePage(await s.context.newPage()); s.pages.push(fresh); fresh.setDefaultTimeout(15_000);
  await s.page.close();
  await fresh.goto(`${s.server.origin}/#code=${s.server.auth.issuePairCode()}`);
  await byId(fresh, "sidebar").waitFor();
  s.page = fresh;
  return fresh;
}

/** 打开插件节点并等标题出现。 */
async function open(page, id, title) {
  await node(page, id).click();
  await byId(page, "plugin-title").filter({ hasText: title }).waitFor();
}

test("插件输入框的在途提交：首次结果回来前刷新，原文按无法确认放回；响应挂起时浏览器超时按结果未知结算；冲突先放回再重取快照", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  let { page } = s;
  s.allowedErrors.push(/Failed to load resource: net::ERR_FAILED/); // 刷新和浏览器超时中止了在途请求。

  // 普通发送：请求已到插件、结果还没回来时刷新。发送时原文已移出输入框，只在在途记录里；刷新后输入框挂载时按无法确认放回。
  await open(page, "uitest:session:a", "任务甲");
  plugin().sendMode = "hold";
  let sends = plugin().calls.send.length;
  await editor(page).fill("刷新前没有结果的文字");
  await byId(page, "plugin-send").click();
  await until(async () => (await value(page)) === "" && plugin().calls.send.length === sends + 1);
  await page.reload();
  plugin().releaseSend({ status: "rejected", message: "插件拒绝了这条消息" });
  await open(page, "uitest:session:a", "任务甲");
  await until(async () => (await value(page)) === "刷新前没有结果的文字");
  await byId(page, "restored-notice").filter({ hasText: "1 条无法确认是否已经发送" }).waitFor();
  await editor(page).fill("");
  await byId(page, "restored-notice").waitFor({ state: "detached" });

  // 结果回来前关闭标签页：页面没有机会处理结果，另一个标签页打开该节点时从在途记录取回原文。
  sends = plugin().calls.send.length;
  await editor(page).fill("关页前没有结果的文字");
  await byId(page, "plugin-send").click();
  await until(async () => (await value(page)) === "" && plugin().calls.send.length === sends + 1);
  page = await reopenTab(s);
  plugin().releaseSend({ status: "rejected", message: "插件拒绝了这条消息" });
  await open(page, "uitest:session:a", "任务甲");
  await until(async () => (await value(page)) === "关页前没有结果的文字");
  await byId(page, "restored-notice").waitFor();
  await editor(page).fill("");

  // composer 动作：同上。
  await open(page, "uitest:session:d", "排队的任务");
  plugin().composerMode = "hold";
  const invokes = plugin().calls.invoke.length;
  await editor(page).fill("关页前没有结果的留言");
  await byId(page, "plugin-send").click();
  await until(async () => (await value(page)) === "" && plugin().calls.invoke.length === invokes + 1);
  page = await reopenTab(s);
  plugin().composerMode = "ok"; plugin().releaseNote();
  await open(page, "uitest:session:d", "排队的任务");
  await until(async () => (await value(page)) === "关页前没有结果的留言");
  await byId(page, "restored-notice").waitFor();
  await editor(page).fill("");

  // 浏览器等待插件请求的超时（正式为 75 秒）缩短为 1.5 秒：响应挂起时按结果未知结算，原文放回，留下“查询结果”。
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms) => timeout(ms >= 60_000 ? 1_500 : ms);
  });
  await page.reload();
  await open(page, "uitest:session:a", "任务甲");
  plugin().sendMode = "hold";
  await editor(page).fill("响应挂起的文字");
  await byId(page, "plugin-send").click();
  const hung = byId(page, "action-pending").filter({ hasText: "消息的发送结果未知，文字已放回输入框" });
  await hung.waitFor();
  assert.equal(await value(page), "响应挂起的文字");
  // 查询也挂起：同样按超时结束，只说明这次查询没有成功，入口保留；下一次点击发出新的查询，不共用挂起的那次。
  let hold = true; const queries = [];
  await page.route("**/sessions/a/send", async (route) => {
    queries.push(route.request().url());
    if (hold) return; // 不放行也不结束：请求挂起，直到浏览器中止。
    await route.continue().catch(() => {});
  });
  await hung.locator('[data-testid="action-query"]').click();
  await byId(page, "toast").filter({ hasText: "这次查询没有成功" }).waitFor();
  await hung.waitFor();
  hold = false;
  plugin().releaseSend();
  await hung.locator('[data-testid="action-query"]').click();
  await byId(page, "toast").filter({ hasText: "已送达，请删去输入框里放回的文字" }).waitFor();
  await until(async () => (await byId(page, "action-pending").count()) === 0);
  assert.equal(queries.length, 2, "挂起的查询结束后，再次点击发出新的查询");
  await page.unroute("**/sessions/a/send");
  await page.getByText("收到：响应挂起的文字").waitFor();
  await editor(page).fill("");

  // composer 动作的响应挂起：同样按结果未知放回。
  await open(page, "uitest:session:d", "排队的任务");
  plugin().composerMode = "hold";
  await editor(page).fill("响应挂起的留言");
  await byId(page, "plugin-send").click();
  const hungNote = byId(page, "action-pending").filter({ hasText: "“留言”结果未知，文字已放回输入框" });
  await hungNote.waitFor();
  assert.equal(await value(page), "响应挂起的留言");
  plugin().composerMode = "ok"; plugin().releaseNote();
  await hungNote.locator('[data-testid="action-query"]').click();
  await byId(page, "toast").filter({ hasText: "已送达，请删去输入框里放回的文字" }).waitFor();
  await editor(page).fill("");

  // 持久表单的查询挂起：浏览器超时只说明这次查询没有成功，原来的“等待处理”不改成结果未知，弹窗不关，之后可以再查。
  // 前面同样文字的错误提示不会自动消失，先关掉。
  while (await byId(page, "toast").count()) await byId(page, "toast").first().getByRole("button", { name: "关闭" }).click().catch(() => {});
  plugin().addForm({ id: "q1", title: "提问：查询会挂起", pending: true, fields: [{ id: "x", label: "答复", type: "text" }] });
  await byId(page, "pending-item").filter({ hasText: "查询会挂起" }).click();
  await byId(page, "form-dialog").locator("input").fill("好");
  await byId(page, "form-submit").click();
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  await byId(page, "pending-item").filter({ hasText: "查询会挂起" }).filter({ hasText: "等待处理" }).click();
  await byId(page, "form-busy").filter({ hasText: "等待处理" }).waitFor();
  const queryFailed = byId(page, "toast").filter({ hasText: "这次查询没有成功" });
  let holdForm = true;
  await page.route("**/api/plugins/uitest/forms/q1", async (route) => {
    if (holdForm) return; // 挂起，直到浏览器超时中止
    await route.continue().catch(() => {});
  });
  await byId(page, "form-query").click();
  await queryFailed.waitFor();
  assert.equal(await byId(page, "form-busy").filter({ hasText: "等待处理" }).count(), 1, "查询失败不关弹窗、不改原提交状态");
  await byId(page, "pending-item").filter({ hasText: "查询会挂起" }).filter({ hasText: "等待处理" }).waitFor();
  holdForm = false;
  plugin().finishPending({ status: "accepted", message: "答复已处理" });
  await byId(page, "form-query").click();
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  await byId(page, "toast").filter({ hasText: "答复已处理" }).waitFor();
  await page.unroute("**/api/plugins/uitest/forms/q1");
  plugin().removeForm("q1", "handled");

  // 发送返回冲突：服务端已明确没有执行，原文立即放回，不等随后重取的快照；快照到达前发送按钮不可用，
  // 否则重发仍带被拒的旧 controlRevision（plugin-api.md“向会话发消息与停止”）。
  await open(page, "uitest:session:a", "任务甲");
  plugin().sendMode = "conflict";
  let snapshotHeld; const snapshotSeen = new Promise((resolve) => { snapshotHeld = resolve; });
  let releaseSnapshot; const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  await page.route("**/sessions/a/snapshot", async (route) => { snapshotHeld(); await snapshotGate; await route.continue().catch(() => {}); });
  await editor(page).fill("冲突的文字");
  await byId(page, "plugin-send").click();
  await snapshotSeen;
  await until(async () => (await value(page)) === "冲突的文字");
  await byId(page, "toast").filter({ hasText: "会话状态已变化" }).waitFor();
  assert.equal(await byId(page, "plugin-send").isDisabled(), true, "重取的快照到达前不能重发");
  releaseSnapshot();
  await until(async () => !(await byId(page, "plugin-send").isDisabled()));
  await page.unroute("**/sessions/a/snapshot");
  // 重取快照失败：提示后可以重发。
  let failHeld; const failSeen = new Promise((resolve) => { failHeld = resolve; });
  let releaseFail; const failGate = new Promise((resolve) => { releaseFail = resolve; });
  await page.route("**/sessions/a/snapshot", async (route) => { failHeld(); await failGate; await route.abort().catch(() => {}); }, { times: 1 });
  await byId(page, "plugin-send").click();
  await failSeen;
  await until(async () => (await value(page)) === "冲突的文字");
  assert.equal(await byId(page, "plugin-send").isDisabled(), true);
  releaseFail();
  await byId(page, "toast").filter({ hasText: "没有读取到会话的最新状态，可以重新发送" }).waitFor();
  assert.equal(await byId(page, "plugin-send").isDisabled(), false, "重取失败后可以重发");
  plugin().sendMode = "ok";
  await byId(page, "plugin-send").click();
  await page.getByText("收到：冲突的文字").waitFor();
});

test("旧动作的结果不取消用户较新的、仍在等待节点出现的导航；重取快照后工具卡片按新模型显示结果；重取快照在途时原订阅的事件不丢", { timeout: 90_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page } = s;
  s.allowedErrors.push(/Failed to load resource: net::ERR_FAILED/); // 用例中止了取快照的请求。

  // 发起会在结果里带 openNodeId 的留言，等待期间用户点击通知里还不在树里的节点；之后旧动作的结果到达。
  await open(page, "uitest:session:d", "排队的任务");
  plugin().composerMode = "holdOpen";
  await editor(page).fill("跳转留言");
  await byId(page, "plugin-send").click();
  await until(async () => (await value(page)) === "");
  plugin().notify({ id: "n-z", level: "info", title: "新任务丙", nodeId: "uitest:session:z" });
  await byId(page, "notification").filter({ hasText: "新任务丙" }).getByRole("button", { name: "打开" }).click();
  plugin().composerMode = "ok"; plugin().releaseNote();
  await byId(page, "toast").filter({ hasText: "可在会话列表中打开" }).waitFor();
  // 用户等待的节点出现后照常打开。
  plugin().branch("z", [], ["任务丙的消息"]);
  plugin().upsert({ id: "uitest:session:z", source: "uitest", kind: "session", parentId: "uitest:group:tasks", title: "任务丙", status: "running",
    availability: "online", hasChildren: false, sortKey: "1z", revision: 0, capabilities: ["open", "subscribe"], sessionRef: { source: "uitest", id: "z" } });
  await page.locator('[data-testid="plugin-session"][data-node-id="uitest:session:z"]').waitFor();
  await page.getByText("任务丙的消息", { exact: true }).waitFor();

  // 工具调用的结果只经重取的快照到达（重取前没有事件）：两份快照的模型版本都是 0，工具卡片要按新模型显示“完成”。
  plugin().branch("t", [], []);
  const session = plugin().sessions.get("t");
  const call = { type: "message", id: "t1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }], timestamp: Date.now(), stopReason: "toolUse" } };
  session.entries = [call];
  plugin().upsert({ id: "uitest:session:t", source: "uitest", kind: "session", parentId: "uitest:group:tasks", title: "有工具的任务", status: "running",
    availability: "online", hasChildren: false, sortKey: "1t", revision: 0, capabilities: ["open", "subscribe"], sessionRef: { source: "uitest", id: "t" } });
  await open(page, "uitest:session:t", "有工具的任务");
  const card = page.locator('[data-testid="tool-card"][data-tool-call-id="call-1"]');
  await card.filter({ hasText: "等待结果" }).waitFor();
  session.entries = [call, { type: "message", id: "t2", parentId: "t1", timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "file.txt" }], isError: false, timestamp: Date.now() } }];
  const refetched = page.waitForResponse((response) => response.url().endsWith("/sessions/t/snapshot"));
  plugin().setSend("uitest:session:t", "t", true); // send 能力变化时重取快照
  await refetched;
  await card.filter({ hasText: "完成" }).waitFor();

  // 会话结束时同时撤销 send 和 subscribe：send 变化触发重取快照，原订阅保留。快照在途时原订阅送来的最后输出和结束状态先存下，
  // 取快照失败时直接应用，不等快照恢复；快照恢复后不重复显示。
  const exact = (text) => page.getByText(text, { exact: true });
  plugin().branch("f", [], ["任务戊的消息"]);
  const f = plugin().upsert({ id: "uitest:session:f", source: "uitest", kind: "session", parentId: "uitest:group:tasks", title: "任务戊", status: "running",
    availability: "online", hasChildren: false, sortKey: "1f", revision: 0, capabilities: ["open", "subscribe", "send"], sessionRef: { source: "uitest", id: "f" } });
  await open(page, "uitest:session:f", "任务戊");
  await exact("任务戊的消息").waitFor();
  await editor(page).waitFor();
  await until(() => plugin().listening("f") === 1);
  let failing = true;
  let heldOnce; const snapshotHeld = new Promise((resolve) => { heldOnce = resolve; });
  let releaseFailure; const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  await page.route("**/sessions/f/snapshot", async (route) => {
    if (!failing) { await route.continue().catch(() => {}); return; }
    heldOnce(); await failureGate; await route.abort().catch(() => {});
  });
  plugin().upsert({ ...f, status: "done", capabilities: ["open"] });
  await snapshotHeld;
  plugin().append("f", "任务戊最后的输出");
  plugin().sessions.get("f").status = "done";
  plugin().emit("f", { type: "pane_status", status: "done", phase: "idle" });
  // 事件经 WebSocket 送到页面需要时间，留出余量后才让快照失败，确认它们是在快照在途时收到的。
  await new Promise((resolve) => setTimeout(resolve, 500));
  releaseFailure();
  await exact("任务戊最后的输出").waitFor();
  await byId(page, "plugin-status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(plugin().listening("f"), 1, "撤销 subscribe 不退订");
  failing = false;
  await until(async () => (await byId(page, "plugin-error").count()) === 0); // 退避重试取到快照
  assert.equal(await exact("任务戊最后的输出").count(), 1);
  await byId(page, "plugin-status").filter({ hasText: "已完成" }).waitFor();
  await page.unroute("**/sessions/f/snapshot");

  // 快照取自事件之前、事件在快照在途时到达：快照到达后接在它的游标之后应用，只显示一次。
  const reloaded = page.waitForResponse((response) => response.url().endsWith("/sessions/f/snapshot"));
  plugin().upsert({ ...f, status: "running", capabilities: ["open", "send"] });
  await reloaded;
  await editor(page).waitFor();
  let fetchedOld; const oldFetched = new Promise((resolve) => { fetchedOld = resolve; });
  let releaseOld; const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  await page.route("**/sessions/f/snapshot", async (route) => {
    const response = await route.fetch(); fetchedOld(); await oldGate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  plugin().upsert({ ...f, status: "done", capabilities: ["open"] });
  await oldFetched;
  plugin().append("f", "快照之后的输出");
  await new Promise((resolve) => setTimeout(resolve, 500));
  releaseOld();
  await exact("快照之后的输出").waitFor();
  await until(async () => (await byId(page, "plugin-readonly").count()) === 1);
  assert.equal(await exact("快照之后的输出").count(), 1);
});
