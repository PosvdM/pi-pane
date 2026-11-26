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

test("没有确定送达就放回原文：处理中、首发断网后放回一次，关掉查询条或刷新不丢文字；查询被拒（403）或断网不结算原操作；连续查询只发一次；open 能力变化；只有 abort 的节点可停止；只读条停止的文字存入草稿；撤销 subscribe 不退订", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page } = s;
  s.allowedErrors.push(/Failed to load resource: net::ERR_FAILED/); // 下面模拟发送请求断网。
  s.allowedErrors.push(/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/); // 下面断网时可能有请求在途（如 /new 之后的列表刷新）。
  s.allowedErrors.push(/status of 403/); // 下面模拟查询时连接尚未重新登记，服务端返回 403 invalidOrigin。

  // 只有确定送达（accepted）不放回；处理中、被拒、断网、超时都在首次响应时把原文放回输入框（放在期间新写的内容之前，只放一次）。
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  const sendKeys = [];
  page.on("request", (request) => { if (request.url().endsWith("/sessions/a/send")) sendKeys.push(request.postDataJSON().idempotencyKey); });
  const queryOf = (op) => op.locator('[data-testid="action-query"]').click();
  const sendText = async (value) => { await editor(page).fill(value); await byId(page, "plugin-send").click(); };
  const cleared = async () => { await until(async () => (await byId(page, "action-pending").count()) === 0); };
  const backOp = byId(page, "action-pending").filter({ hasText: "文字已放回输入框" });
  /** 同样文字的提示可能还没消失（error 提示要手动关闭，最多保留 5 条）：先关掉已有的提示，再等这一步的提示出现。 */
  const toastAfter = async (text, act) => {
    while (await byId(page, "toast").count()) await byId(page, "toast").first().getByRole("button", { name: "关闭" }).click().catch(() => {});
    await act(); await byId(page, "toast").filter({ hasText: text }).first().waitFor();
  };

  // pending：原文立即放回，留下“查询结果”；查到被拒只提示结果，不重复放回。
  plugin().sendMode = "pending";
  await sendText("普通发送的文字");
  const sendOp = byId(page, "action-pending").filter({ hasText: "插件仍在处理，文字已放回输入框" });
  await sendOp.waitFor();
  assert.equal(await editor(page).inputValue(), "普通发送的文字");
  plugin().finishPending({ status: "rejected", message: "插件拒绝了这条消息" });
  await queryOf(sendOp);
  await byId(page, "toast").filter({ hasText: "插件拒绝了这条消息" }).waitFor();
  await cleared();
  assert.equal(await editor(page).inputValue(), "普通发送的文字", "只放回一次");
  assert.equal(sendKeys.length, 2); assert.equal(sendKeys[0], sendKeys[1], "查询沿用同一个幂等键");
  await editor(page).fill("");

  // pending 后关掉查询条：原文已在输入框，关闭只放弃查询，文字不丢。
  await sendText("关掉查询条的文字");
  await sendOp.waitFor();
  await sendOp.getByRole("button", { name: "关闭" }).click();
  await cleared();
  assert.equal(await editor(page).inputValue(), "关掉查询条的文字");
  plugin().finishPending({ status: "rejected", message: "迟到的拒绝" });
  await editor(page).fill("");

  // pending 后刷新页面：放回的原文写入本标签页对该节点的草稿存储，刷新后仍在输入框中。
  await sendText("刷新前的文字");
  await sendOp.waitFor();
  await page.reload();
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  await until(async () => (await editor(page).inputValue()) === "刷新前的文字");
  plugin().finishPending({ status: "rejected", message: "迟到的拒绝" });
  await editor(page).fill("");

  // 查询本身被拒（WebSocket 重连期间，连接还没重新登记，服务端对这次查询返回 403 invalidOrigin）：
  // 只说明这次查询没有成功，不结算原操作，入口保留；之后查到已送达时提示删去放回的文字。
  let staleQuery = false;
  await page.route("**/sessions/a/send", async (route) => {
    if (!staleQuery) { await route.continue().catch(() => {}); return; }
    staleQuery = false;
    await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), connectionId: "已断开的连接" }) }).catch(() => {});
  });
  await sendText("查询被拒的文字");
  await sendOp.waitFor();
  staleQuery = true;
  const invalid = page.waitForResponse((response) => response.url().endsWith("/sessions/a/send") && response.status() === 403);
  await queryOf(sendOp);
  await invalid;
  await byId(page, "toast").filter({ hasText: "这次查询没有成功" }).waitFor();
  await sendOp.waitFor();
  assert.equal(await editor(page).inputValue(), "查询被拒的文字");
  plugin().finishPending({ status: "accepted" });
  await toastAfter("已送达，请删去输入框里放回的文字", () => queryOf(sendOp));
  await cleared();
  assert.equal(await editor(page).inputValue(), "查询被拒的文字", "放回的文字由用户删除");
  await editor(page).fill("");
  await page.unroute("**/sessions/a/send");

  // 首发断网：请求送到服务端、插件已处理，响应在回到浏览器的路上丢失。原文放回，之后的查询结算。
  const lose = async (route) => { await route.fetch().catch(() => {}); await route.abort("failed"); };
  let armed = null;
  await page.route("**/sessions/a/send", async (route) => { const handler = armed; armed = null; if (handler) await handler(route); else await route.continue().catch(() => {}); });
  const once = (handler) => { armed = handler; };

  // 首发断网（插件已受理、仍在处理）→ 查询断网 → 查询被拒：放回一次；查询断网只提示，被拒时不重复放回。
  once(lose);
  await sendText("第四段文字");
  await backOp.waitFor();
  await until(async () => (await editor(page).inputValue()) === "第四段文字");
  once((route) => route.abort("failed"));
  await toastAfter("这次查询没有成功", () => queryOf(backOp));
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
  await toastAfter("已送达，请删去输入框里放回的文字", () => queryOf(backOp));
  await cleared();
  await page.getByText("收到：第五段文字").waitFor();
  await editor(page).fill("");
  await page.unroute("**/sessions/a/send");

  // 连续点两次“查询结果”只发一次查询；查到后续表单并提交后已执行：原文在 pending 时已放回，提示删去。
  await node(page, "uitest:session:d").click();
  await byId(page, "plugin-title").filter({ hasText: "排队的任务" }).waitFor();
  plugin().composerMode = "pending";
  await editor(page).fill("要查询的留言");
  await byId(page, "plugin-send").click();
  const noteOp = byId(page, "action-pending").filter({ hasText: "留言处理中" });
  await noteOp.waitFor();
  assert.equal(await editor(page).inputValue(), "要查询的留言");
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
  await toastAfter("已送达，请删去输入框里放回的文字", () => byId(page, "form-submit").click());
  await byId(page, "toast").filter({ hasText: "已留言" }).first().waitFor();
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  assert.equal(await editor(page).inputValue(), "要查询的留言", "只放回一次");
  await editor(page).fill("");

  // composer 动作的结果迟到并带 openNodeId：结果到达前用户已切换到其他节点，不跳转，只提示；没有切换时照常打开。
  plugin().composerMode = "holdOpen";
  await editor(page).fill("跳转留言");
  await byId(page, "plugin-send").click();
  await until(async () => (await editor(page).inputValue()) === "");
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  plugin().releaseNote();
  await byId(page, "toast").filter({ hasText: "可在会话列表中打开" }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await byId(page, "plugin-session").getAttribute("data-node-id"), "uitest:session:a", "没有被拉回发起的节点");
  plugin().composerMode = "holdOpen";
  plugin().upsert({ ...plugin().nodes.get("uitest:session:a"), composer: { actionId: "uitest.note" } });
  await byId(page, "plugin-composer").filter({ hasText: "作为“留言”提交" }).waitFor();
  await editor(page).fill("留在原处的留言");
  await byId(page, "plugin-send").click();
  await until(async () => (await editor(page).inputValue()) === "");
  plugin().releaseNote();
  await page.locator('[data-testid="plugin-session"][data-node-id="uitest:session:d"]').waitFor();
  const restoredA = plugin().nodes.get("uitest:session:a"); delete restoredA.composer;
  plugin().upsert(restoredA);
  plugin().composerMode = "ok";

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

  // 撤销 subscribe 只影响以后是否新建订阅：已建立的订阅保持到离开该节点，不退订、不补取快照，已展开的历史保留。
  // 会话结束时插件常先撤销 subscribe，最后的输出和结束状态晚于树更新到达，仍经这条订阅送来。
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
  await until(() => plugin().listening("h") === 1);
  await older().click();
  await exact("更早的消息").waitFor();
  assert.equal(hSnapshots.length, 1);
  const subscribesBefore = plugin().calls.subscribe.length;
  plugin().upsert({ ...h, status: "done", capabilities: ["open"] });
  await synced("open");
  plugin().append("h", "最后的输出");
  plugin().emit("h", { type: "pane_status", status: "done", phase: "idle" });
  await exact("最后的输出").waitFor();
  await byId(page, "plugin-status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(plugin().listening("h"), 1, "撤销 subscribe 不退订");
  assert.equal(hSnapshots.length, 1, "撤销 subscribe 不补取快照");
  assert.equal(await exact("更早的消息").count(), 1, "已展开的历史保留");
  // 补回 subscribe：已有订阅，不再新建订阅，也不重取快照。
  plugin().upsert({ ...h, status: "running", capabilities: ["open", "subscribe"] });
  await synced("open subscribe");
  plugin().append("h", "补回后的输出");
  await exact("补回后的输出").waitFor();
  assert.equal(plugin().calls.subscribe.slice(subscribesBefore).filter((c) => c.id === "h").length, 0, "补回时不重复订阅");
  assert.equal(plugin().listening("h"), 1);
  assert.equal(hSnapshots.length, 1, "补回实时流不重取快照");

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
