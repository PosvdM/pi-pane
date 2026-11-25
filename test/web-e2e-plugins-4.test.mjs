import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { until } from "./fixtures/helpers.mjs";
import { byId, newSession, observePage, send, setup } from "./fixtures/web-e2e.mjs";

const pluginDir = fileURLToPath(new URL("./fixtures/ui-plugin/", import.meta.url));
const plugin = () => globalThis.__uiPlugin;
const node = (page, id) => page.locator(`[data-node-id="${id}"]`).first();
const editor = (page) => byId(page, "plugin-editor");
const say = { fallback: { segments: [{ type: "text", text: "好的" }] } };

test("普通发送处理中可查询、查到被拒时放回文字；处理中或首发断网之后的查询（断网、被拒、已受理）由同一操作结算，原文只放回一次；连续查询只发一次；open 能力变化；只有 abort 的节点可停止；只读条停止的文字存入草稿", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page } = s;
  s.allowedErrors.push(/Failed to load resource: net::ERR_FAILED/); // 下面模拟发送请求断网。

  // 普通发送（sessions.send）返回处理中：输入框清空，留下“查询结果”；同一个键查到被拒时文字放回。
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  const sendKeys = [];
  page.on("request", (request) => { if (request.url().endsWith("/sessions/a/send")) sendKeys.push(request.postDataJSON().idempotencyKey); });
  plugin().sendMode = "pending";
  await editor(page).fill("普通发送的文字");
  await byId(page, "plugin-send").click();
  const sendOp = byId(page, "action-pending").filter({ hasText: "插件仍在处理" });
  await sendOp.waitFor();
  assert.equal(await editor(page).inputValue(), "");
  plugin().finishPending({ status: "rejected", message: "插件拒绝了这条消息" });
  await sendOp.locator('[data-testid="action-query"]').click();
  await byId(page, "toast").filter({ hasText: "插件拒绝了这条消息" }).waitFor();
  await until(async () => (await editor(page).inputValue()) === "普通发送的文字");
  await until(async () => (await byId(page, "action-pending").count()) === 0);
  assert.equal(sendKeys.length, 2); assert.equal(sendKeys[0], sendKeys[1], "查询沿用同一个幂等键");
  await editor(page).fill("");

  // 每次发送是一个操作对象：首次响应、每次查询、断网都交给它结算，原文最多放回一次。
  const queryOf = (op) => op.locator('[data-testid="action-query"]').click();
  const drop = (route) => route.abort("failed");
  /** 请求送到服务端、插件已处理，响应在回到浏览器的路上丢失。 */
  const lose = async (route) => { await route.fetch().catch(() => {}); await route.abort("failed"); };
  let armed = null;
  await page.route("**/sessions/a/send", async (route) => { const handler = armed; armed = null; if (handler) await handler(route); else await route.continue().catch(() => {}); });
  const once = (handler) => { armed = handler; };
  const sendText = async (value) => { await editor(page).fill(value); await byId(page, "plugin-send").click(); };
  const cleared = async () => { await until(async () => (await byId(page, "action-pending").count()) === 0); };

  // pending → 查询断网 → 查询被拒：断网时原文放回（提示与实际一致），之后查到被拒不再重复放回。
  plugin().sendMode = "pending";
  await sendText("第二段文字");
  await sendOp.waitFor();
  assert.equal(await editor(page).inputValue(), "");
  once(drop);
  await queryOf(sendOp);
  const backOp = byId(page, "action-pending").filter({ hasText: "文字已放回输入框" });
  await backOp.waitFor();
  await until(async () => (await editor(page).inputValue()) === "第二段文字");
  plugin().finishPending({ status: "rejected", message: "插件拒绝了第二段" });
  await queryOf(backOp);
  await byId(page, "toast").filter({ hasText: "插件拒绝了第二段" }).waitFor();
  await cleared();
  assert.equal(await editor(page).inputValue(), "第二段文字", "只放回一次");
  await editor(page).fill("");

  // pending → 查询已受理：结束，原文不放回。
  await sendText("第三段文字");
  await sendOp.waitFor();
  plugin().finishPending({ status: "accepted" });
  await queryOf(sendOp);
  await cleared();
  assert.equal(await editor(page).inputValue(), "");

  // 首发断网（插件已受理、仍在处理）→ 查询被拒：断网时放回一次，被拒时不重复。
  once(lose);
  await sendText("第四段文字");
  await backOp.waitFor();
  await until(async () => (await editor(page).inputValue()) === "第四段文字");
  plugin().finishPending({ status: "rejected", message: "插件拒绝了第四段" });
  await queryOf(backOp);
  await byId(page, "toast").filter({ hasText: "插件拒绝了第四段" }).waitFor();
  await cleared();
  assert.equal(await editor(page).inputValue(), "第四段文字");
  await editor(page).fill("");

  // 首发断网（插件已执行）→ 查询已受理：原文已放回，提示删去。
  plugin().sendMode = "ok";
  once(lose);
  await sendText("第五段文字");
  await backOp.waitFor();
  await until(async () => (await editor(page).inputValue()) === "第五段文字");
  await queryOf(backOp);
  await byId(page, "toast").filter({ hasText: "已送达，请删去输入框里放回的文字" }).waitFor();
  await cleared();
  await page.getByText("收到：第五段文字").waitFor();
  await editor(page).fill("");
  await page.unroute("**/sessions/a/send");

  // 连续点两次“查询结果”只发一次查询；查到后续表单并提交后，已执行的文字不放回。
  await node(page, "uitest:session:d").click();
  await byId(page, "plugin-title").filter({ hasText: "排队的任务" }).waitFor();
  plugin().composerMode = "pending";
  await editor(page).fill("要查询的留言");
  await byId(page, "plugin-send").click();
  const noteOp = byId(page, "action-pending").filter({ hasText: "留言处理中" });
  await noteOp.waitFor();
  plugin().finishPending({ status: "needsInput", followUpForm: { id: "note-more", source: "uitest", revision: 1, title: "补充留言", createdAt: new Date().toISOString(), fields: [{ id: "more", label: "补充", type: "text" }] } });
  plugin().composerMode = "ok";
  const noteKeys = [];
  page.on("request", (request) => { if (request.url().includes("/actions/uitest.note/invoke")) noteKeys.push(request.postDataJSON().idempotencyKey); });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/actions/uitest.note/invoke", async (route) => { await gate; await route.continue().catch(() => {}); });
  const query = noteOp.locator('[data-testid="action-query"]');
  await query.click(); await query.click();
  release();
  await byId(page, "form-dialog").filter({ hasText: "补充留言" }).waitFor();
  await page.unroute("**/actions/uitest.note/invoke");
  assert.equal(noteKeys.length, 1, "两次点击共用一次查询");
  await byId(page, "form-dialog").locator("input").fill("补充内容");
  await byId(page, "form-submit").click();
  await byId(page, "toast").filter({ hasText: "已留言" }).waitFor();
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await editor(page).inputValue(), "", "已执行的留言不放回输入框");

  // 运行中撤销 open：已显示的内容和订阅撤掉，只剩节点信息与停止；补回 open 后重新取快照并订阅。
  await node(page, "uitest:session:a").click();
  await page.getByText("开始任务甲").waitFor();
  const a = plugin().nodes.get("uitest:session:a");
  plugin().upsert({ ...a, capabilities: a.capabilities.filter((c) => c !== "open") });
  await byId(page, "plugin-closed").waitFor();
  assert.equal(await page.getByText("开始任务甲").count(), 0);
  await byId(page, "plugin-readonly").locator('[data-testid="plugin-stop"]').waitFor();
  plugin().upsert({ ...plugin().nodes.get("uitest:session:a"), capabilities: [...a.capabilities] });
  await page.getByText("开始任务甲").waitFor();
  await byId(page, "plugin-closed").waitFor({ state: "detached" });
  plugin().append("a", "重新开放后的输出");
  await page.getByText("重新开放后的输出").waitFor();

  // 只声明 abort、不开放内容的节点：可以停止；只读条停止清出的文字存入该节点的草稿，开放输入后出现在输入框里。
  plugin().upsert({ id: "uitest:session:e", source: "uitest", kind: "session", parentId: "uitest:group:tasks", title: "只能停止的任务", status: "running",
    availability: "online", hasChildren: false, sortKey: "1e", revision: 0, capabilities: ["abort"], sessionRef: { source: "uitest", id: "e" } });
  await node(page, "uitest:session:e").click();
  await byId(page, "plugin-closed").waitFor();
  const aborts = plugin().calls.abort;
  await byId(page, "plugin-stop").click();
  await byId(page, "toast").filter({ hasText: "已存入该会话的输入框" }).waitFor();
  assert.equal(plugin().calls.abort, aborts + 1);
  plugin().upsert({ ...plugin().nodes.get("uitest:session:e"), capabilities: ["open", "send"] });
  await editor(page).waitFor();
  await until(async () => (await editor(page).inputValue()) === "排队的消息");

  // 首次快照在途时节点能力变化：在途的快照取自变化之前（只读），完成后要再取一次，输入框随之出现。
  plugin().setSend("uitest:session:a", "a", false);
  let fetched; const fetchedOnce = new Promise((resolve) => { fetched = resolve; });
  let releaseSnap; const snapGate = new Promise((resolve) => { releaseSnap = resolve; });
  let held = true;
  await page.route("**/sessions/a/snapshot", async (route) => {
    if (!held) { await route.continue().catch(() => {}); return; }
    held = false;
    const response = await route.fetch(); fetched(); await snapGate;
    await route.fulfill({ response }).catch(() => {});
  });
  await node(page, "uitest:session:a").click();
  await fetchedOnce;
  plugin().setSend("uitest:session:a", "a", true);
  // 确认浏览器已在旧快照返回之前处理了能力更新，再放行旧快照。
  await page.waitForFunction(() => /(^| )send( |$)/.test(document.querySelector('[data-testid="plugin-session"]')?.getAttribute("data-synced-capabilities") ?? ""));
  releaseSnap();
  await page.getByText("开始任务甲").waitFor();
  await editor(page).waitFor();
  await page.unroute("**/sessions/a/snapshot");

  // 只撤销 subscribe：不重取快照，已展开的历史保留；补回 subscribe 时从当前游标续订。
  const synced = (caps) => page.waitForFunction((want) => document.querySelector('[data-testid="plugin-session"]')?.getAttribute("data-synced-capabilities") === want, caps);
  const exact = (value) => page.getByText(value, { exact: true });
  const older = () => page.getByRole("button", { name: "加载更早的消息" });
  plugin().branch("h", ["更早的消息"], ["当前的消息"]);
  const h = plugin().upsert({ id: "uitest:session:h", source: "uitest", kind: "session", parentId: "uitest:group:tasks", title: "有历史的任务", status: "running",
    availability: "online", hasChildren: false, sortKey: "1h", revision: 0, capabilities: ["open", "subscribe"], sessionRef: { source: "uitest", id: "h" } });
  const hSnapshots = [];
  page.on("request", (request) => { if (request.url().endsWith("/sessions/h/snapshot")) hSnapshots.push(request.url()); });
  await node(page, "uitest:session:h").click();
  await exact("当前的消息").waitFor();
  await older().click();
  await exact("更早的消息").waitFor();
  assert.equal(hSnapshots.length, 1);
  plugin().upsert({ ...h, capabilities: ["open"] });
  await synced("open");
  plugin().upsert({ ...h, capabilities: ["open", "subscribe"] });
  await synced("open subscribe");
  plugin().append("h", "续订后的输出");
  await exact("续订后的输出").waitFor();
  assert.equal(await exact("更早的消息").count(), 1, "已展开的历史保留");
  assert.equal(hSnapshots.length, 1, "只有实时流变化时不重取快照");

  // 分支切换（resync 重取快照）之后，迟到的旧分支历史页丢弃，不覆盖新分支的“加载更早的消息”。
  plugin().branch("h", ["旧分支更早的消息"], ["旧分支的消息"]); plugin().resync("h");
  await exact("旧分支的消息").waitFor();
  let pageFetched; const fetchedPage = new Promise((resolve) => { pageFetched = resolve; });
  let releasePage; const pageGate = new Promise((resolve) => { releasePage = resolve; });
  await page.route("**/sessions/h/history*", async (route) => { const response = await route.fetch(); pageFetched(); await pageGate; await route.fulfill({ response }).catch(() => {}); });
  await older().click();
  await fetchedPage;
  plugin().branch("h", ["新分支更早的消息"], ["新分支的消息"]); plugin().resync("h");
  await exact("新分支的消息").waitFor();
  const pageDone = page.waitForEvent("requestfinished", (request) => request.url().includes("/sessions/h/history"));
  releasePage();
  await pageDone;
  await page.unroute("**/sessions/h/history*");
  // 响应处理后会立即拼进模型；留出足够的时间确认没有发生。
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await exact("旧分支更早的消息").count(), 0);
  await older().click();
  await exact("新分支更早的消息").waitFor();
});

test("插件节点挂在项目分组下并与主会话按 sortKey 统一排序；打开插件节点后主会话迟到的 /new 结果不拉走视图；重连后已打开的面板重取；确认框跟随设备变化；窄屏不能拖动侧栏", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page, fixture } = s;
  await node(page, "uitest:session:a").waitFor();

  // 项目分组：插件节点和主会话合并显示，按 sortKey 统一排序（主会话的 sortKey 以数字开头）。
  await newSession(page, fixture);
  const id = await byId(page, "chat").getAttribute("data-session-id");
  const main = `pane:session:${id}`;
  const project = byId(page, "project").filter({ has: page.locator(`[data-node-id="${main}"]`) });
  const projectId = await project.getAttribute("data-project-id");
  const base = { source: "uitest", kind: "session", status: "running", availability: "online", hasChildren: false, revision: 0, capabilities: ["open"] };
  plugin().upsert({ ...base, id: "uitest:session:p1", parentId: projectId, title: "项目里靠前的节点", sortKey: "!", sessionRef: { source: "uitest", id: "p1" } });
  plugin().upsert({ ...base, id: "uitest:session:p2", parentId: projectId, title: "项目里靠后的节点", sortKey: "~~", sessionRef: { source: "uitest", id: "p2" } });
  const ids = ["uitest:session:p1", main, "uitest:session:p2"];
  await until(async () => (await project.locator(".tree-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-node-id")))).filter((x) => ids.includes(x)).length === 3);
  const order = (await project.locator(".tree-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-node-id")))).filter((x) => ids.includes(x));
  assert.deepEqual(order, ids);
  assert.equal(await byId(page, "unassigned").count(), 0);

  // 主会话执行 /new，结果返回前打开插件节点：插件导航使主会话的导航代次失效，迟到的切换结果不把视图拉回主会话。
  await send(page, "你好");
  await byId(page, "assistant-message").filter({ hasText: "好的" }).waitFor();
  let releaseControl; const controlGate = new Promise((resolve) => { releaseControl = resolve; });
  let controlHeld; const held = new Promise((resolve) => { controlHeld = resolve; });
  // 扣住请求，等打开插件节点之后才送到服务端：替换事件和控制响应都晚于插件导航到达。
  await page.route("**/api/sessions/*/control", async (route) => { controlHeld(); await controlGate; await route.continue().catch(() => {}); });
  await byId(page, "composer").fill("/new"); await byId(page, "composer").press("Escape"); await byId(page, "composer").press("Enter");
  await held;
  const mainSnapshots = [];
  page.on("request", (request) => { if (/\/api\/sessions\/[^/]+\/snapshot/.test(request.url())) mainSnapshots.push(request.url()); });
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  const answered = page.waitForEvent("requestfinished", (request) => request.url().endsWith("/control"));
  releaseControl();
  await answered;
  await page.unroute("**/api/sessions/*/control");
  // 响应处理后立即会打开新会话（取快照）；留出足够的时间确认没有发生。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(mainSnapshots, [], "不再打开新主会话");
  assert.equal(await byId(page, "plugin-title").filter({ hasText: "任务甲" }).count(), 1);
  assert.equal(await byId(page, "chat").count(), 0);

  // 已打开的面板此前没收到过推送：断线期间内容变化，重连后重新拉取。
  await node(page, "uitest:session:a").click();
  const panel = byId(page, "node-panel");
  await panel.filter({ hasText: "running" }).waitFor();
  await s.context.setOffline(true);
  await byId(page, "net-banner").waitFor();
  plugin().nodes.get("uitest:session:a").status = "paused";
  await s.context.setOffline(false);
  await panel.filter({ hasText: "paused" }).waitFor();

  // 确认框打开后另一个标签页重置密钥：确认框改显示新设备，签名用的也是新设备。
  const other = observePage(await s.context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
  await other.goto(s.server.origin); await byId(other, "sidebar").waitFor();
  plugin().addForm({ id: "pd", title: "提问：确认框打开后重置", presence: 30_000, fields: [{ id: "x", label: "答复", type: "text" }] });
  await byId(page, "pending-item").filter({ hasText: "确认框打开后重置" }).click();
  await byId(page, "form-submit").click();
  await byId(page, "presence-dialog").waitFor();
  const shown = byId(page, "presence-device");
  await shown.waitFor();
  const before = await shown.getAttribute("title");
  await byId(other, "open-settings").click();
  await other.getByRole("button", { name: "重置设备密钥" }).click();
  await other.getByRole("button", { name: "重置", exact: true }).click();
  await byId(other, "toast").filter({ hasText: "已重置设备密钥" }).waitFor();
  await until(async () => (await shown.getAttribute("title")) !== before);
  const after = await shown.getAttribute("title");
  await byId(page, "presence-confirm").click();
  await until(async () => (await byId(page, "pending-item").filter({ hasText: "确认框打开后重置" }).count()) === 0);
  assert.equal(plugin().calls.presence.at(-1).formId, "pd");
  assert.equal(plugin().calls.presence.at(-1).deviceId, after, "签名设备与确认框显示的一致");
  await other.close(); s.pages.splice(s.pages.indexOf(other), 1);

  // 窄屏（≤760px）：侧栏是固定宽度的浮层，不显示拖动手柄，拖动也不改保存的宽度。
  const saved = await page.evaluate(() => localStorage.getItem("pi-pane.sidebarWidth"));
  await page.setViewportSize({ width: 700, height: 800 });
  assert.equal(await byId(page, "sidebar-resizer").isVisible(), false);
  await byId(page, "sidebar-resizer").dispatchEvent("pointerdown");
  await page.mouse.move(420, 300); await page.mouse.move(430, 300); await page.mouse.up();
  assert.equal(await page.evaluate(() => localStorage.getItem("pi-pane.sidebarWidth")), saved);
  await page.setViewportSize({ width: 1280, height: 800 });
});
