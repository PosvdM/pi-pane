import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { until } from "./fixtures/helpers.mjs";
import { byId, newSession, setup } from "./fixtures/web-e2e.mjs";

const pluginDir = fileURLToPath(new URL("./fixtures/ui-plugin/", import.meta.url));
const plugin2Dir = fileURLToPath(new URL("./fixtures/ui-plugin-2/", import.meta.url));
const plugin = () => globalThis.__uiPlugin;
const node = (page, id) => page.locator(`[data-node-id="${id}"]`).first();
const say = { fallback: { segments: [{ type: "text", text: "好的" }] } };

test("节点点击打开适用的面板；只改树节点能力也开放输入；状态说明；应用内确认；没有横幅的插件停用后界面刷新；空会话标题", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir, plugin2Dir] }) }); if (!s) return;
  const { page, fixture } = s;

  // 分组：点击展开或折叠，同时打开适用的节点面板。
  await node(page, "uitest:session:a").waitFor();
  await node(page, "uitest:group:tasks").click();
  await byId(page, "plugin-node").waitFor();
  await byId(page, "node-panel").filter({ hasText: "uitest:group:tasks" }).waitFor();
  assert.equal(await page.locator('[data-testid="tree-node"][data-node-id="uitest:session:a"]').count(), 0, "分组已折叠");
  await node(page, "uitest:group:tasks").click();
  await node(page, "uitest:session:a").waitFor();
  // 资源：打开适用的面板。
  await node(page, "uitest2:resource:doc").click();
  await byId(page, "node-panel").filter({ hasText: "资源文档内容" }).waitFor();

  // 插件只通过树节点去掉、再加回 send 能力，会话流没有 pane_status：输入框随之消失、出现。
  await node(page, "uitest:session:a").click();
  await byId(page, "plugin-editor").waitFor();
  plugin().setSend("uitest:session:a", "a", false);
  await byId(page, "plugin-readonly").waitFor();
  plugin().setSend("uitest:session:a", "a", true);
  await byId(page, "plugin-editor").waitFor();
  // pane_status 的 detail 显示在底部状态栏。
  plugin().emit("a", { type: "pane_status", status: "running", phase: "idle", detail: "正在整理结果" });
  await byId(page, "plugin-statusbar").filter({ hasText: "正在整理结果" }).waitFor();
  // composer 提示不带具体插件的语义（如“不中断当前运行”）。
  await node(page, "uitest:session:d").click();
  await page.locator(".composer-hint").filter({ hasText: "提交给 测试插件" }).waitFor();
  assert.doesNotMatch(await page.locator(".composer-hint").textContent(), /不中断/);

  // 带 confirm 的动作使用应用内确认框，不弹浏览器的 confirm()。
  let nativeDialogs = 0; page.on("dialog", (dialog) => { nativeDialogs++; void dialog.dismiss(); });
  await byId(page, "add-menu-btn").click();
  await byId(page, "global-action").filter({ hasText: "清空" }).click();
  await byId(page, "choice-dialog").filter({ hasText: "确定清空？" }).locator('[data-choice="cancel"]').click();
  await byId(page, "choice-dialog").waitFor({ state: "detached" });
  assert.equal(plugin().calls.invoke.filter((c) => c.actionId === "uitest.wipe").length, 0);
  await byId(page, "add-menu-btn").click();
  await byId(page, "global-action").filter({ hasText: "清空" }).click();
  await byId(page, "choice-dialog").locator('[data-choice="ok"]').click();
  await until(() => plugin().calls.invoke.some((c) => c.actionId === "uitest.wipe"));
  assert.equal(nativeDialogs, 0);

  // 停用没有横幅的插件：服务端推送插件变化，树、侧栏面板随之移除。
  await s.server.plugins.runtime.stop("uitest2");
  await until(async () => (await byId(page, "plugin-roots").filter({ hasText: "第二测试插件" }).count()) === 0);
  await until(async () => (await byId(page, "side-panel").filter({ hasText: "第二看板" }).count()) === 0);
  await byId(page, "side-panel").filter({ hasText: "测试看板" }).waitFor();

  // 没有名称和首条消息的主会话显示“（空会话）”，不显示会话 ID。
  await newSession(page, fixture);
  const id = await byId(page, "chat").getAttribute("data-session-id");
  await page.locator(`[data-testid="session-item"][data-node-id="pane:session:${id}"]`).filter({ hasText: "（空会话）" }).waitFor();
});

test("持久表单：查询到已处理时关闭弹窗；提交在途时关闭再打开只显示进度，不能再交一次", { timeout: 120_000 }, async (t) => {
  const s = await setup(t, say, { serverOptions: () => ({ plugins: [pluginDir] }) }); if (!s) return;
  const { page } = s;
  await node(page, "uitest:session:a").waitFor();

  plugin().addForm({ id: "p1", title: "提问：处理中的事项", pending: true, fields: [{ id: "x", label: "答复", type: "text" }] });
  await byId(page, "pending-item").filter({ hasText: "处理中的事项" }).click();
  await byId(page, "form-dialog").locator("input").fill("好");
  await byId(page, "form-submit").click();
  // 插件受理后仍在处理：弹窗关闭，待处理区显示进度；重开后只有“查询结果”。
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  await byId(page, "pending-item").filter({ hasText: "等待处理" }).click();
  await byId(page, "form-busy").filter({ hasText: "等待处理" }).waitFor();
  plugin().finishPending({ status: "alreadyHandled", message: "已在别处处理" });
  await byId(page, "form-query").click();
  await byId(page, "form-dialog").waitFor({ state: "detached" });

  // 提交请求在途：关闭弹窗后从待处理区重开，只显示进度，没有提交按钮。
  plugin().addForm({ id: "p2", title: "提问：慢慢提交", fields: [{ id: "x", label: "答复", type: "text" }] });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/plugins/uitest/forms/p2", async (route) => { await gate; await route.continue().catch(() => {}); });
  await byId(page, "pending-item").filter({ hasText: "慢慢提交" }).click();
  await byId(page, "form-dialog").locator("input").fill("好");
  await byId(page, "form-submit").click();
  await byId(page, "form-later").click();
  await byId(page, "pending-item").filter({ hasText: "慢慢提交" }).filter({ hasText: "提交中" }).click();
  await byId(page, "form-busy").filter({ hasText: "正在提交" }).waitFor();
  assert.equal(await byId(page, "form-submit").count(), 0);
  release(); await page.unroute("**/api/plugins/uitest/forms/p2");
  await byId(page, "form-dialog").waitFor({ state: "detached" });
  assert.equal(plugin().calls.submit.filter((c) => c.formId === "p2").length, 1);
});
