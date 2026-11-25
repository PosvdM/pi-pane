import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { until } from "./fixtures/helpers.mjs";
import { byId, newSession, observePage, setup } from "./fixtures/web-e2e.mjs";

const pluginDir = fileURLToPath(new URL("./fixtures/ui-plugin/", import.meta.url));
const plugin2Dir = fileURLToPath(new URL("./fixtures/ui-plugin-2/", import.meta.url));
const plugin = () => globalThis.__uiPlugin;
const node = (page, id) => page.locator(`[data-node-id="${id}"]`).first();
const editor = (page) => byId(page, "plugin-editor");

test("插件输入框：提交即清空、被拒或放弃后放回、等待期间新写的文字保留、结果未知与处理中可查询；排队任务可停止；标题栏动作超过 3 个进“⋯”", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "好的" }] } }, {
    serverOptions: () => ({ plugins: [pluginDir] }), allowedErrors: [/status of 504/],
  }); if (!s) return;
  const { page } = s;
  await node(page, "uitest:session:d").click();
  await byId(page, "plugin-title").filter({ hasText: "排队的任务" }).waitFor();
  // 等待中、没有运行的任务声明了 abort：停止入口照常提供。
  await byId(page, "plugin-status").filter({ hasText: "等待中" }).waitFor();
  await byId(page, "plugin-stop").waitFor();
  // 4 个动作：标题栏 3 个，第 4 个在“⋯”菜单里。
  assert.equal(await byId(page, "node-head-action").count(), 3);
  await byId(page, "head-more").click();
  await byId(page, "head-menu-action").filter({ hasText: "附加二" }).waitFor();
  await page.mouse.click(600, 400);

  // 插件拒绝：文字放回输入框。
  plugin().composerMode = "reject";
  await editor(page).fill("第一段");
  await byId(page, "plugin-send").click();
  await byId(page, "toast").filter({ hasText: "插件拒绝了留言" }).waitFor();
  await until(async () => (await editor(page).inputValue()) === "第一段");

  // 请求期间继续输入：成功后只移除已提交的部分。
  plugin().composerMode = "hold";
  await byId(page, "plugin-send").click();
  await until(async () => (await editor(page).inputValue()) === "");
  await editor(page).fill("等待期间写的");
  plugin().releaseNote();
  await page.getByText("留言：第一段").waitFor();
  assert.equal(await editor(page).inputValue(), "等待期间写的");

  // 请求期间写的文字按节点保存：切到别的节点、请求在此期间完成，回来后文字还在。
  plugin().composerMode = "hold";
  await editor(page).fill("第二段");
  await byId(page, "plugin-send").click();
  await until(async () => (await editor(page).inputValue()) === "");
  await editor(page).fill("新写的");
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  plugin().releaseNote();
  await node(page, "uitest:session:d").click();
  await page.getByText("留言：第二段").waitFor();
  assert.equal(await editor(page).inputValue(), "新写的");
  // 机器较慢时，上面等待放行的请求可能超过动作超时（1 秒），服务端按“结果未知”返回 pending，留下查询入口，文字不放回。
  // 插件随后已执行：查询结算为已送达，入口消失，输入框里期间新写的文字不受影响。
  await until(async () => {
    const entries = byId(page, "action-pending");
    if ((await entries.count()) === 0) return true;
    await entries.first().locator('[data-testid="action-query"]').click({ timeout: 1000 }).catch(() => {});
    return false;
  });
  assert.equal(await editor(page).inputValue(), "新写的");

  // needsInput：放弃后续表单视为没有执行，文字放回。
  plugin().composerMode = "needsInput";
  await editor(page).fill("要补充的");
  await byId(page, "plugin-send").click();
  await byId(page, "form-dialog").filter({ hasText: "补充留言" }).waitFor();
  await byId(page, "form-close").click();
  await until(async () => (await editor(page).inputValue()) === "要补充的");

  // 处理中：文字不放回，留下“查询结果”；用同一个键查到插件最终没有执行时，文字放回原节点的输入框。
  const keys = [];
  page.on("request", (request) => { if (request.url().includes("/actions/uitest.note/invoke")) keys.push(request.postDataJSON().idempotencyKey); });
  await editor(page).fill("");
  plugin().composerMode = "pending";
  await editor(page).fill("排队留言");
  await byId(page, "plugin-send").click();
  await byId(page, "action-pending").filter({ hasText: "留言处理中" }).waitFor();
  assert.equal(await editor(page).inputValue(), "");
  plugin().finishPending({ status: "failed", message: "留言没有送达" });
  await byId(page, "action-pending").filter({ hasText: "留言处理中" }).locator('[data-testid="action-query"]').click();
  await byId(page, "toast").filter({ hasText: "留言没有送达" }).waitFor();
  await until(async () => (await editor(page).inputValue()) === "排队留言");
  await until(() => keys.length === 2);
  assert.equal(keys[0], keys[1], "查询沿用同一个幂等键");

  // 超过动作超时：服务端按“结果未知”返回 pending，文字不放回；之后查询得到成功。
  await editor(page).fill("");
  plugin().composerMode = "slow";
  await editor(page).fill("慢留言");
  await byId(page, "plugin-send").click();
  await byId(page, "action-pending").filter({ hasText: "结果未知" }).waitFor({ timeout: 20_000 });
  assert.equal(await editor(page).inputValue(), "");
  await page.getByText("留言：慢留言").waitFor({ timeout: 10_000 });
  await byId(page, "action-pending").filter({ hasText: "结果未知" }).locator('[data-testid="action-query"]').click();
  await until(async () => (await byId(page, "action-pending").count()) === 0);
  assert.equal(await editor(page).inputValue(), "", "查到已执行，文字不放回");

  // 会话视图先报告已结束、树节点的 abort 能力还没撤下时，不再提供停止。
  plugin().emit("d", { type: "pane_status", status: "stopped", phase: "idle" });
  await byId(page, "plugin-status").filter({ hasText: "已停止" }).waitFor();
  await byId(page, "plugin-stop").waitFor({ state: "detached" });
});

test("跨来源的树、历史数与“未归属”；同名侧栏面板按来源区分；主会话的节点面板；切换面板不显示旧行；“详情”记忆、窄屏抽屉与侧栏宽度", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "好的" }] } }, {
    serverOptions: () => ({ plugins: [pluginDir, plugin2Dir] }),
  }); if (!s) return;
  const { page, fixture } = s;
  // 第二个插件的节点挂在第一个插件的分组下；两边的冷节点合计为“历史（3）”（uitest 2 个，uitest2 1 个）。
  await node(page, "uitest2:session:guest").waitFor();
  await byId(page, "unassigned").filter({ hasText: "走失的任务" }).waitFor();
  const group = page.locator('[data-node-id="uitest:group:tasks"] ~ [data-testid="node-history"]').first();
  await group.filter({ hasText: "历史（3）" }).waitFor();
  await group.click();
  for (const id of ["uitest:session:old", "uitest:session:old2", "uitest2:session:guest-old"]) await node(page, id).waitFor();
  // 有子节点、数目未知：显示不带数字的“历史”。
  const root = byId(page, "plugin-roots").filter({ hasText: "第二测试插件" });
  await root.locator('[data-testid="node-history"]').filter({ hasText: /^历史$/ }).click();
  await node(page, "uitest2:session:root-old").waitFor();

  // 两个插件各有一个 id 为 uitest.board 的侧栏面板：角标各自更新。
  const board1 = byId(page, "side-panel").filter({ hasText: "测试看板" }).locator(".count-badge");
  const board2 = byId(page, "side-panel").filter({ hasText: "第二看板" }).locator(".count-badge");
  await board1.filter({ hasText: "2" }).waitFor(); await board2.filter({ hasText: "7" }).waitFor();
  plugin().panelChanged({ panelId: "uitest.board", revision: 5, badgeCount: 9 });
  await board1.filter({ hasText: "9" }).waitFor();
  assert.equal(await board2.textContent(), "7");
  globalThis.__uiPlugin2.panelChanged({ panelId: "uitest.board", revision: 2, badgeCount: 1 });
  await board2.filter({ hasText: "1" }).waitFor();
  assert.equal(await board1.textContent(), "9", "较低的修订号来自另一个来源，不被当作过期");

  // 切换面板：新内容到达前不显示旧面板的行和行动作。
  await node(page, "uitest:session:a").click();
  await byId(page, "node-panel").waitFor();
  await byId(page, "panel-tab").filter({ hasText: "任务清单" }).click();
  await byId(page, "panel-row-action").waitFor();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/panels/uitest.detail?*", async (route) => { await gate; await route.continue().catch(() => {}); });
  await byId(page, "panel-tab").filter({ hasText: "任务详情" }).click();
  await byId(page, "panel-loading").waitFor();
  assert.equal(await byId(page, "panel-row-action").count(), 0);
  release(); await page.unroute("**/panels/uitest.detail?*");
  await byId(page, "node-panel").filter({ hasText: "uitest:session:a" }).waitFor();

  // “详情”按浏览器记住：关闭后刷新页面仍关闭。
  await byId(page, "details-toggle").click();
  await byId(page, "node-panel").waitFor({ state: "detached" });
  await page.reload();
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  assert.equal(await byId(page, "node-panel").count(), 0);
  await byId(page, "details-toggle").click();
  await byId(page, "node-panel").waitFor();

  // 窄屏：面板是覆盖在会话视图上的抽屉，默认收起。
  await page.setViewportSize({ width: 1000, height: 760 });
  await node(page, "uitest:session:d").click();
  await byId(page, "plugin-title").filter({ hasText: "排队的任务" }).waitFor();
  assert.equal(await byId(page, "node-panel").count(), 0);
  await byId(page, "details-toggle").click();
  await page.locator('[data-testid="node-panel"].drawer').waitFor();
  await byId(page, "panel-close").click();
  await byId(page, "node-panel").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 800 });

  // 主会话的节点面板（appliesTo.sources 含 pane）。
  await newSession(page, fixture);
  await byId(page, "node-panel").filter({ hasText: "主会话面板" }).waitFor();
  const id = await byId(page, "chat").getAttribute("data-session-id");
  await byId(page, "node-panel").filter({ hasText: "pane:session:" + id }).waitFor();

  // 侧栏宽度：拖动范围 240–480px，按浏览器记住。
  const resizer = byId(page, "sidebar-resizer");
  const box = await resizer.boundingBox();
  await page.mouse.move(box.x + 2, box.y + 200); await page.mouse.down(); await page.mouse.move(900, 200); await page.mouse.up();
  assert.equal(Math.round((await byId(page, "sidebar").boundingBox()).width), 480);
  const box2 = await resizer.boundingBox();
  await page.mouse.move(box2.x + 2, box2.y + 200); await page.mouse.down(); await page.mouse.move(50, 200); await page.mouse.up();
  assert.equal(Math.round((await byId(page, "sidebar").boundingBox()).width), 240);
  assert.equal(await page.evaluate(() => localStorage.getItem("pi-pane.sidebarWidth")), "240");
});

test("横幅超过 3 条折叠、通知保留需手动关闭的项；断线期间在别处处理的表单在重连后关闭；旧节点重载不吞新节点事件", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "好的" }] } }, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page } = s;
  await node(page, "uitest:session:a").waitFor();
  for (const [id, level] of [["b1", "error"], ["b2", "warning"], ["b3", "info"], ["b4", "info"]]) plugin().banner({ id, level, title: "横幅" + id });
  await byId(page, "banners-more").filter({ hasText: "另有 2 条横幅" }).waitFor();
  assert.deepEqual(await byId(page, "banner-title").allTextContents(), ["横幅b1", "横幅b2"]);
  await byId(page, "banners-more").click();
  await until(async () => (await byId(page, "banner-title").count()) === 4);
  await byId(page, "banners-less").click();
  await until(async () => (await byId(page, "banner-title").count()) === 2);

  plugin().notify({ id: "err", level: "error", title: "需要处理的错误" });
  plugin().notify({ id: "stick", level: "info", title: "常驻提示", sticky: true });
  for (let i = 0; i < 6; i++) plugin().notify({ id: "n" + i, level: "info", title: "普通通知" + i });
  await byId(page, "notification").filter({ hasText: "普通通知5" }).waitFor();
  assert.equal(await byId(page, "notification").filter({ hasText: "普通通知" }).count(), 5);
  await byId(page, "notification").filter({ hasText: "需要处理的错误" }).waitFor();
  await byId(page, "notification").filter({ hasText: "常驻提示" }).waitFor();
  // info 5 秒后消失，error 和 sticky 留下。
  await until(async () => (await byId(page, "notification").filter({ hasText: "普通通知" }).count()) === 0, 9000);
  assert.equal(await byId(page, "notification").count(), 2);

  // 打开一张表单后断线；断线期间它在别处被处理（插件不再列出），重连对齐后弹窗关闭。
  plugin().addForm({ id: "gone", title: "提问：会被别处处理", fields: [{ id: "x", label: "答复", type: "text" }] });
  plugin().addForm({ id: "stay", title: "提问：仍然待处理", fields: [{ id: "x", label: "答复", type: "text" }] });
  await byId(page, "pending-item").filter({ hasText: "会被别处处理" }).click();
  await byId(page, "form-dialog").filter({ hasText: "会被别处处理" }).waitFor();
  await s.context.setOffline(true);
  await byId(page, "net-banner").waitFor();
  // 插件在本标签页断线期间移除表单（如另一个标签页已处理）：本标签页收不到这条移除帧。
  plugin().removeForm("gone", "handled");
  await s.context.setOffline(false);
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  await byId(page, "toast").filter({ hasText: "该事项已在别处处理" }).waitFor();
  await until(async () => (await byId(page, "pending-item").count()) === 1);
  await byId(page, "pending-item").filter({ hasText: "仍然待处理" }).waitFor();

  // 节点甲的重载挂起时切到排队的任务：新节点的事件照常显示，甲的重载完成后不影响它。
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/sessions/a/snapshot", async (route) => { await gate; await route.continue().catch(() => {}); });
  const held = page.waitForRequest((request) => request.url().endsWith("/sessions/a/snapshot"));
  plugin().resync("a"); await held;
  await node(page, "uitest:session:d").click();
  await byId(page, "plugin-title").filter({ hasText: "排队的任务" }).waitFor();
  plugin().append("d", "新节点的输出");
  await page.getByText("新节点的输出").waitFor();
  release(); await page.unroute("**/sessions/a/snapshot");
  plugin().append("d", "之后的输出");
  await page.getByText("之后的输出").waitFor();
  assert.equal(await byId(page, "plugin-title").textContent(), "排队的任务测试插件");
});

test("在场确认：另一个标签页重置设备密钥后仍能签名生效；浏览器不能签名时确认直接以 unsupported 结束", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "好的" }] } }, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page } = s;
  await node(page, "uitest:session:a").waitFor();
  const other = observePage(await s.context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
  await other.goto(s.server.origin); await byId(other, "sidebar").waitFor();
  const before = await page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open("pi-pane-device", 1);
    open.onsuccess = () => { const req = open.result.transaction("keys").objectStore("keys").get("device"); req.onsuccess = () => resolve(req.result.deviceId); };
  }));
  // 在第二个标签页重置密钥；第一个标签页之后的签名用新密钥，服务端按重新登记的设备核对。
  await byId(other, "open-settings").click();
  await other.getByRole("button", { name: "重置设备密钥" }).click();
  await other.getByRole("button", { name: "重置", exact: true }).click();
  await byId(other, "toast").filter({ hasText: "已重置设备密钥" }).waitFor();
  plugin().addForm({ id: "p1", title: "提问：重置后确认", presence: 20_000, fields: [{ id: "x", label: "答复", type: "text" }] });
  await byId(page, "pending-item").filter({ hasText: "重置后确认" }).click();
  await byId(page, "form-submit").click();
  await byId(page, "presence-dialog").waitFor();
  await byId(page, "presence-confirm").click();
  await until(async () => (await byId(page, "pending-item").filter({ hasText: "重置后确认" }).count()) === 0);
  const submitted = plugin().calls.submit.at(-1);
  assert.equal(submitted.formId, "p1");
  assert.notEqual(submitted.origin.deviceId, before, "确认时登记的是重置后的新设备");
  await other.close(); s.pages.splice(s.pages.indexOf(other), 1);

  // 不支持 IndexedDB 的标签页：确认框不等用户操作，直接以 unsupported 结束。
  const bare = observePage(await s.context.newPage()); s.pages.push(bare); bare.setDefaultTimeout(15_000);
  await bare.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true }); });
  await bare.goto(s.server.origin); await byId(bare, "sidebar").waitFor();
  plugin().addForm({ id: "p2", title: "提问：不能签名", presence: 20_000, fields: [{ id: "x", label: "答复", type: "text" }] });
  await byId(bare, "pending-item").filter({ hasText: "不能签名" }).click();
  await byId(bare, "form-submit").click();
  await byId(bare, "form-error").filter({ hasText: "确认失败：unsupported" }).waitFor();
  await byId(bare, "toast").filter({ hasText: "本浏览器无法签名" }).waitFor();
});
