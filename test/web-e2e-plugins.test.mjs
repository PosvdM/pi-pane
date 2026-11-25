import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { until } from "./fixtures/helpers.mjs";
import { byId, idle, newSession, observePage, send, sessionView, setup } from "./fixtures/web-e2e.mjs";

const pluginDir = fileURLToPath(new URL("./fixtures/ui-plugin/", import.meta.url));
const withPlugin = { serverOptions: () => ({ plugins: [pluginDir] }) };
const plugin = () => globalThis.__uiPlugin;
const node = (page, id) => page.locator(`[data-node-id="${id}"]`).first();

test("插件 Chrome 会话树、插件会话视图、输入框、停止、节点面板、动作表单与 resync 重试", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, {
    turns: [{ segments: [{ type: "toolCall", id: "call-1", name: "missing_tool", arguments: { task: "乙" } }] }, { segments: [{ type: "text", text: "已派出子任务" }] }],
    fallback: { segments: [{ type: "text", text: "好的" }] },
  }, { ...withPlugin, allowedErrors: [/status of 502/] }); if (!s) return;
  const { page, fixture } = s;
  // 插件根节点以 displayName 分组；冷历史只显示数目，展开后分页加载。
  await byId(page, "plugin-roots").filter({ hasText: "测试插件" }).waitFor();
  await node(page, "uitest:group:tasks").waitFor();
  await byId(page, "node-history").filter({ hasText: "历史（2）" }).click();
  await node(page, "uitest:session:old").waitFor();
  await node(page, "uitest:session:old2").waitFor();

  // 打开运行中的插件会话：发送、停止后清出的文字回到输入框。
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-session").waitFor();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();
  await byId(page, "crumbs").filter({ hasText: "测试任务" }).waitFor();
  await byId(page, "node-panel").filter({ hasText: "uitest:session:a" }).waitFor();
  await byId(page, "plugin-editor").fill("第一条");
  await byId(page, "plugin-send").click();
  await page.getByText("收到：第一条").waitFor();
  await byId(page, "plugin-stop").click();
  await until(() => plugin().calls.abort === 1);
  await until(async () => (await byId(page, "plugin-editor").inputValue()) === "排队的消息");

  // 节点动作：先取表单，再带答案调用。
  await byId(page, "node-head-action").filter({ hasText: "返工" }).click();
  await byId(page, "form-dialog").filter({ hasText: "返工说明" }).waitFor();
  await byId(page, "form-submit").click();
  await byId(page, "form-error").filter({ hasText: "返工要求" }).waitFor();
  await byId(page, "form-dialog").locator("textarea").fill("补测试");
  await byId(page, "form-submit").click();
  await until(() => plugin().calls.invoke.some((c) => c.actionId === "uitest.retry" && c.input?.fields?.note === "补测试" && c.formId === "retry-uitest:session:a"));
  assert.equal(await byId(page, "form-dialog").count(), 0);
  const retry = plugin().calls.invoke.find((c) => c.actionId === "uitest.retry");
  assert.equal(retry.origin.client, "browser");
  // 右键菜单列出节点动作。
  await node(page, "uitest:session:a").click({ button: "right" });
  await byId(page, "node-menu").filter({ hasText: "返工" }).waitFor();
  await page.keyboard.press("Escape"); await page.mouse.click(900, 400);

  // 后台离线：resync 后取快照失败时持续重试，恢复后续订。
  plugin().failSnapshots = 2;
  plugin().resync("a");
  await page.getByText("正在重试").first().waitFor();
  await until(async () => (await page.getByText("正在重试").count()) === 0, 15_000);
  plugin().append("a", "恢复后的输出");
  await page.getByText("恢复后的输出").waitFor();
  // 接管：只读状态与输入框及时更新。
  plugin().setReadonly("a", true);
  await byId(page, "plugin-readonly").waitFor();
  assert.equal(await byId(page, "plugin-editor").count(), 0);

  // 主会话：插件节点挂在主会话下，工具卡片链接到它。
  await newSession(page, fixture);
  await send(page, "派一个子任务");
  await idle(s);
  const main = await sessionView(s);
  plugin().attach(main.ref.id, "call-1");
  await byId(page, "tool-node-link").filter({ hasText: "打开 子任务乙" }).click();
  await byId(page, "plugin-title").filter({ hasText: "子任务乙" }).waitFor();
  await byId(page, "plugin-composer").filter({ hasText: "作为“插话”提交给 测试插件" }).waitFor();
  await byId(page, "plugin-editor").fill("加快进度");
  await byId(page, "plugin-send").click();
  await page.getByText("插话：加快进度").waitFor();
  assert.ok(plugin().calls.invoke.some((c) => c.actionId === "uitest.steer" && c.target.nodeId === "uitest:session:b"));
  await byId(page, "crumbs").locator("button").filter({ hasText: "派一个子任务" }).click();
  await byId(page, "chat").waitFor();
  assert.equal(await byId(page, "chat").getAttribute("data-session-id"), main.ref.id);
});

test("插件 Chrome 待处理区、持久表单、在场确认、多标签页同 revision 只生效一次", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "好的" }] } }, withPlugin); if (!s) return;
  const { page } = s;
  await node(page, "uitest:session:a").waitFor();
  plugin().addForm({ id: "q1", title: "提问：选择方案", nodeId: "uitest:session:a", presence: 20_000,
    questions: [{ id: "plan", question: "用哪个方案？", options: [{ label: "甲", recommended: true }, { label: "乙" }], allowCustom: false }] });
  await byId(page, "pending-count").filter({ hasText: "1" }).waitFor();
  await node(page, "uitest:session:a").locator('[data-testid="node-pending"]').waitFor();
  await node(page, "uitest:session:a").click();
  await byId(page, "node-pending-banner").filter({ hasText: "提问：选择方案" }).locator("button").click();
  await byId(page, "form-dialog").waitFor();
  // “稍后处理”只关闭弹窗，表单留在待处理区。
  await byId(page, "form-later").click();
  assert.equal(await byId(page, "pending-item").count(), 1);
  await byId(page, "pending-item").click();
  await byId(page, "form-option").filter({ hasText: "甲" }).click();
  await byId(page, "form-submit").click();
  // 提交在插件里等待在场确认：确认框出现在提交的标签页，签名后表单移除。
  await byId(page, "presence-dialog").filter({ hasText: "确认答复" }).waitFor();
  await byId(page, "presence-countdown").waitFor();
  await byId(page, "presence-confirm").click();
  await until(async () => (await byId(page, "pending").count()) === 0);
  const submitted = plugin().calls.submit.at(-1);
  assert.deepEqual(submitted.outcome, { status: "submitted", values: { answers: [{ id: "plan", selected: ["甲"] }] } });
  assert.equal(submitted.origin.client, "browser");

  // 拒绝确认：插件返回失败，表单保留。
  plugin().addForm({ id: "q2", title: "待确认：删除分支", presence: 20_000, fields: [{ id: "why", label: "原因", type: "text" }] });
  await byId(page, "pending-item").filter({ hasText: "待确认：删除分支" }).click();
  await byId(page, "form-submit").click();
  await byId(page, "presence-reject").click();
  await byId(page, "form-error").filter({ hasText: "确认失败" }).waitFor();
  await byId(page, "form-later").click();

  // 两个标签页提交同一 revision：只有一个生效，另一个显示已在别处处理。
  plugin().addForm({ id: "q3", title: "决策：是否继续", questions: [{ id: "go", question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }], allowCustom: false }] });
  const other = observePage(await s.context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
  await other.goto(s.server.origin); await byId(other, "sidebar").waitFor();
  for (const tab of [page, other]) {
    await byId(tab, "pending-item").filter({ hasText: "决策：是否继续" }).click();
    await byId(tab, "form-option").filter({ hasText: "继续" }).click();
  }
  // 第一页的提交先被拦住，第二页提交并生效后再放行：插件对同一 revision 的第二次提交返回 alreadyHandled。
  let release; const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/plugins/uitest/forms/q3", async (route) => { await gate; await route.continue(); });
  const held = page.waitForRequest((request) => request.url().endsWith("/api/plugins/uitest/forms/q3"));
  await byId(page, "form-submit").click(); await held;
  await byId(other, "form-submit").click();
  await until(() => plugin().calls.submit.filter((c) => c.formId === "q3").length === 1);
  release();
  await until(async () => (await byId(page, "pending-item").filter({ hasText: "决策" }).count()) === 0 && (await byId(other, "pending-item").filter({ hasText: "决策" }).count()) === 0);
  const toasts = [await byId(page, "toast").allTextContents(), await byId(other, "toast").allTextContents()].flat().join("\n");
  assert.match(toasts, /已在别处处理/);
  assert.match(toasts, /已提交/);
});

test("插件 Chrome 横幅、通知、全局动作结果未知后查询、侧栏面板、未知面板与停用插件", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, { fallback: { segments: [{ type: "text", text: "好的" }] } }, {
    ...withPlugin, allowedErrors: [/status of 504/, /status of 404/],
  }); if (!s) return;
  const { page } = s;
  await node(page, "uitest:session:a").waitFor();
  plugin().banner({ id: "reset", level: "warning", title: "设备记录已被重置", body: "需要重新批准设备。", actions: ["uitest.ping"], persistent: true });
  plugin().banner({ id: "info", level: "info", title: "普通提示" });
  plugin().banner({ id: "off", level: "error", title: "用户确认保护已关闭", persistent: true });
  await until(async () => (await byId(page, "banner-title").allTextContents()).join("|") === "用户确认保护已关闭|设备记录已被重置|普通提示");
  // 同一条横幅更新保持位置；新的修订不会被旧内容覆盖。
  plugin().banner({ id: "reset", level: "warning", title: "设备记录已被重置（第二次）", actions: ["uitest.ping"], persistent: true });
  await byId(page, "banner-title").filter({ hasText: "第二次" }).waitFor();
  await byId(page, "global-banner").filter({ hasText: "第二次" }).locator(".g-banner-line").click();
  await byId(page, "banner-action").filter({ hasText: "检查状态" }).click();
  await byId(page, "plugin-title").filter({ hasText: "任务甲" }).waitFor();

  // 动作结果的 openNodeId 指向尚未推送到浏览器的节点：等节点出现后打开。
  await byId(page, "add-menu-btn").click();
  await byId(page, "global-action").filter({ hasText: "新建任务" }).click();
  await byId(page, "plugin-title").filter({ hasText: "新建的任务" }).waitFor();

  plugin().notify({ id: "n1", level: "info", title: "任务甲已完成", nodeId: "uitest:session:a" });
  plugin().notify({ id: "n1", level: "info", title: "任务甲已完成", nodeId: "uitest:session:a" });
  await byId(page, "notification").filter({ hasText: "任务甲已完成" }).waitFor();
  assert.equal(await byId(page, "notification").count(), 1, "同 id 的通知只显示一次");

  // 全局动作超时：显示结果未知，“查询结果”用同一个键取得最终结果。
  const keys = [];
  page.on("request", (request) => { if (request.url().includes("/actions/uitest.slow/invoke")) keys.push(request.postDataJSON().idempotencyKey); });
  await byId(page, "add-menu-btn").click();
  await byId(page, "global-action").filter({ hasText: "慢动作" }).click();
  await byId(page, "action-pending").filter({ hasText: "结果未知" }).waitFor({ timeout: 20_000 });
  plugin().releaseSlow();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await byId(page, "action-query").click();
  await byId(page, "toast").filter({ hasText: "慢动作完成" }).waitFor();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1], "查询结果沿用同一个幂等键");

  // 侧栏面板带角标，panelChanged 更新角标；group 节点显示面板，未知类型提示升级。
  await byId(page, "side-panel").filter({ hasText: "测试看板" }).locator(".count-badge").filter({ hasText: "2" }).waitFor();
  plugin().panelChanged({ panelId: "uitest.board", revision: 2, badgeCount: 5 });
  await byId(page, "side-panel").locator(".count-badge").filter({ hasText: "5" }).waitFor();
  await node(page, "uitest:group:tasks").click({ button: "right" });
  await byId(page, "node-detail").click();
  await byId(page, "plugin-node").waitFor();
  await byId(page, "node-panel").filter({ hasText: "uitest:group:tasks" }).waitFor();
  await byId(page, "node-panel").locator(".panel-tab").filter({ hasText: "将来的面板" }).click();
  await byId(page, "panel-unsupported").filter({ hasText: "此面板需要更新的 pi-pane" }).waitFor();

  // 停用插件：persistent 横幅保留并标为来源不可用，动作不可用；非 persistent 横幅和插件节点移除。
  await s.server.plugins.runtime.stop("uitest");
  await byId(page, "banner-unavailable").first().waitFor();
  await until(async () => (await byId(page, "banner-title").allTextContents()).join("|") === "用户确认保护已关闭|设备记录已被重置（第二次）");
  assert.equal(await byId(page, "banner-action").first().isDisabled(), true);
  await until(async () => (await byId(page, "plugin-roots").count()) === 0);
});
