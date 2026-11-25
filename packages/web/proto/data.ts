// 原型的假数据。形状取自 @pi-pane/plugin-api，业务内容按 pi-agora integration.md 的映射编写，时间固定，便于截图复现。
import type {
  ActionSpec, BannerState, FormSpec, InFlightBlock, PaneNotification, PanelContent, PanelSpec, PresenceDevice, TreeNode, UserPresenceRequest,
} from "@pi-pane/plugin-api";

export const NOW = Date.parse("2026-11-25T15:30:00+08:00");
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
const later = (minutes: number) => new Date(NOW + minutes * 60000).toISOString();

/** 主会话列表项（对应 pane 自己的 `pane:session:*` 节点；正式实现取自 GET /api/sessions）。 */
export interface MainSession { id: string; cwd: string; title: string; modifiedAt: string; messageCount: number; status?: string }
export const MAIN_SESSIONS: MainSession[] = [
  { id: "s1", cwd: "/Users/pm/code/pi-pane", title: "M3 插件界面实现", modifiedAt: ago(1), messageCount: 46, status: "idle" },
  { id: "s2", cwd: "/Users/pm/code/pi-pane", title: "修复 WebSocket 重连后的重复订阅", modifiedAt: ago(140), messageCount: 31 },
  { id: "s3", cwd: "/Users/pm/code/pi-pane", title: "整理 README 的安装步骤", modifiedAt: ago(60 * 26), messageCount: 12 },
  { id: "s4", cwd: "/Users/pm/code/pi-agora", title: "切片 3 设计讨论", modifiedAt: ago(35), messageCount: 58, status: "idle" },
  { id: "s5", cwd: "/Users/pm/code/pi-agora", title: "archive adapter 的分页上限", modifiedAt: ago(60 * 50), messageCount: 22 },
];

const SUB = ["open", "subscribe", "send", "abort", "action:agora.task.steer", "action:agora.task.stop"];
const base = { source: "agora", availability: "online" as const, revision: 1, hasChildren: false };
const ses = (id: string) => ({ source: "agora", id });

/** agora 插件提供的节点。`loaded: false` 表示未在热快照里、要展开“历史”才分页加载。 */
export const PLUGIN_NODES: TreeNode[] = [
  { ...base, id: "agora:session:as_a1", kind: "session", parentId: "pane:session:s1", title: "实现会话树按需加载", badge: "子代理", sessionRef: ses("as_a1"),
    status: "running", statusDetail: "第 2 代 · 执行工具", hasChildren: true, childCount: 2, messageCount: 38, lastActivityAt: ago(0), sortKey: ago(28), capabilities: SUB,
    composer: { actionId: "agora.task.steer", placeholder: "对子代理补充说明或返工", images: false },
    originToolCall: { sessionRef: { source: "pane", id: "s1" }, toolCallId: "tc_spawn_1" } },
  { ...base, id: "agora:session:as_b1", kind: "session", parentId: "agora:session:as_a1", title: "为 TreeStore 补单元测试", badge: "子代理", sessionRef: ses("as_b1"),
    status: "done", availability: "archived", messageCount: 12, lastActivityAt: ago(9), sortKey: ago(20), capabilities: ["open"] },
  { ...base, id: "agora:session:as_b2", kind: "session", parentId: "agora:session:as_a1", title: "调研 Chrome 虚拟列表", badge: "子代理", sessionRef: ses("as_b2"),
    status: "waiting", statusDetail: "等待用户答复提问 · 由 Agent 管理，接管后可操作", messageCount: 17, lastActivityAt: ago(6), sortKey: ago(18),
    capabilities: ["open", "subscribe", "abort", "action:agora.task.takeover", "action:agora.task.stop"] },
  { ...base, id: "agora:session:as_a2", kind: "session", parentId: "pane:session:s1", title: "待处理区与表单弹窗", badge: "子代理", sessionRef: ses("as_a2"),
    status: "waiting", statusDetail: "排队中：第 2 位", messageCount: 0, lastActivityAt: ago(3), sortKey: ago(27), capabilities: ["open", "action:agora.task.stop"] },
  { ...base, id: "agora:session:as_a3", kind: "session", parentId: "pane:session:s1", title: "横幅落盘与恢复", badge: "子代理", sessionRef: ses("as_a3"),
    status: "failed", statusDetail: "测试未通过：banners.json 原子替换", messageCount: 21, lastActivityAt: ago(12), sortKey: ago(26),
    capabilities: ["open", "send", "action:agora.task.steer", "action:agora.task.cleanup"],
    composer: { actionId: "agora.task.steer", placeholder: "对子代理补充说明或返工", images: false } },
  { ...base, id: "agora:session:as_a4", kind: "session", parentId: "pane:session:s1", title: "设备密钥迁移脚本", badge: "子代理", sessionRef: ses("as_a4"),
    status: "paused", statusDetail: "额度暂停，预计 16:40 恢复", messageCount: 9, lastActivityAt: ago(15), sortKey: ago(25), capabilities: ["open", "action:agora.task.recover", "action:agora.task.stop"] },
  { ...base, id: "agora:meeting:mt_1", kind: "group", parentId: "pane:session:s4", title: "切片 3 接口评审", badge: "会议", status: "running", statusDetail: "核对第 2 轮",
    hasChildren: true, childCount: 4, lastActivityAt: ago(2), sortKey: ago(33), capabilities: ["action:agora.meeting.interject", "action:agora.meeting.stop"] },
  { ...base, id: "agora:root:user-tasks", kind: "group", parentId: null, title: "用户任务", badge: "用户任务", status: "idle", hasChildren: true, childCount: 3, sortKey: "1", capabilities: [] },
  { ...base, id: "agora:root:user-meetings", kind: "group", parentId: null, title: "用户会议", badge: "用户会议", status: "idle", hasChildren: true, childCount: 1, sortKey: "2", capabilities: [] },
];
/** 父节点的 childCount 多于已加载的子节点时，差额折叠为“历史（N）”。 */
export const PARENT_TOTALS: Record<string, number> = { "pane:session:s1": 10 };

export const ACTIONS: Record<string, ActionSpec> = {
  "agora.task.steer": { id: "agora.task.steer", source: "agora", title: "返工", scope: ["node"], hasForm: true },
  "agora.task.stop": { id: "agora.task.stop", source: "agora", title: "停止", scope: ["node"], confirm: "停止该子代理？", danger: true },
  "agora.task.cleanup": { id: "agora.task.cleanup", source: "agora", title: "清理", scope: ["node"], hasForm: true },
  "agora.task.recover": { id: "agora.task.recover", source: "agora", title: "恢复", scope: ["node"], hasForm: true },
  "agora.task.takeover": { id: "agora.task.takeover", source: "agora", title: "接管", scope: ["node"], hasForm: true, confirm: "接管后原 Agent 将不能再管理该任务及其子树。" },
  "agora.security.ack": { id: "agora.security.ack", source: "agora", title: "我已知悉", scope: ["global"] },
  "ci-bot.renew": { id: "ci-bot.renew", source: "ci-bot", title: "续期凭据", scope: ["global"] },
};

export const FORMS: FormSpec[] = [
  {
    id: "agora:request:rq_7f2c", source: "agora", revision: 1, title: "提问：会话树的虚拟列表怎么做", createdAt: ago(6), expiresAt: later(24),
    nodeId: "agora:session:as_b2",
    description: "子代理 **调研 Chrome 虚拟列表** 转来的提问（召集人 **实现会话树按需加载** 无法决定，转交给你）。",
    questions: [
      { id: "q1", header: "虚拟列表", question: "会话树节点超过 500 个时用哪种方式渲染？",
        options: [
          { label: "自己实现定高虚拟列表", description: "无新依赖；节点行高固定为 28px", recommended: true },
          { label: "引入 @tanstack/virtual", description: "支持变高行，gzip 约 +4 KiB" },
          { label: "不做虚拟化", description: "只依靠按需加载控制节点数" },
        ] },
      { id: "q2", header: "键盘导航", question: "会话树是否需要键盘导航（上下键移动，左右键展开和折叠）？",
        options: [{ label: "需要" }, { label: "暂不需要" }] },
    ],
    submitLabel: "提交答复", cancel: { label: "不答复，取消提问" },
  },
  {
    id: "agora:confirmation:cf_31", source: "agora", revision: 2, title: "待确认：命令行请求提高任务预算", createdAt: ago(14), expiresAt: later(46),
    nodeId: "agora:session:as_a1",
    description: "`agora task limits as_a1 --max-tokens 2000000`\n\n- 发起方：终端（pid 48213）\n- 预算：1.0M → 2.0M tokens（超过封顶，需要用户确认）",
    submitLabel: "确认", cancel: { label: "拒绝" },
  },
  {
    id: "agora:device:dv_9a", source: "agora", revision: 1, title: "待批准设备：家里 MacBook Chrome", createdAt: ago(31),
    description: "- 标签：家里 MacBook Chrome\n- 公钥指纹：`SHA256:q9Xk…3fTa`\n- 请求时间：15:00",
    submitLabel: "批准", cancel: { label: "拒绝" },
  },
];

export const BANNERS: BannerState[] = [
  { id: "agora:security:devices-reset", source: "agora", sourceUnavailable: false, level: "error", persistent: true, actions: ["agora.security.ack"],
    title: "设备记录已被重置：已配对的浏览器设备全部失效",
    body: "- 检测时间：2026-11-25 15:12\n- 来源：离线命令 `agora devices reset`\n- 当前配对设备：办公室 Chrome（`Xk3f…9a`）\n- 警告 revision：4\n\n如果不是你本人操作，请检查本机上运行的程序。" },
  { id: "agora:security:protection-off", source: "agora", sourceUnavailable: false, level: "error", persistent: true,
    title: "用户确认保护已关闭，无法区分你和 Agent 的操作",
    body: "在终端运行 `agora security protect on` 重新开启后，此横幅自动消失。" },
  { id: "ci-bot:token-expiring", source: "ci-bot", sourceUnavailable: true, level: "warning", persistent: true, actions: ["ci-bot.renew"],
    title: "部署凭据将在 3 天后过期", body: "续期后自动清除。" },
];

export const NOTIFICATION: PaneNotification = {
  id: "n1", source: "agora", level: "info", title: "子代理已完成：为 TreeStore 补单元测试", body: "12 条消息，用时 8 分钟。结果已送达召集人。",
  nodeId: "agora:session:as_b1",
};

export const PRESENCE: { request: UserPresenceRequest; plugin: string; device: PresenceDevice } = {
  plugin: "agora",
  request: {
    title: "答复子代理的提问",
    summary: "以你的身份答复 **调研 Chrome 虚拟列表** 的提问：\n\n- 虚拟列表：自己实现定高虚拟列表\n- 键盘导航：需要，但先只做上下键\n\n确认后用本设备的密钥签名，agora 据此确认是你本人的操作。",
    payload: { kind: "request.answer", requestId: "rq_7f2c", revision: 1, answers: [{ id: "q1", selected: ["自己实现定高虚拟列表"] }, { id: "q2", selected: [], custom: "需要，但先只做上下键" }], nonce: "c2V0LWJ5LWFnb3Jh", expiresAt: later(2) },
    timeoutMs: 120000,
  },
  device: { deviceId: "Xk3f9aQ2mB7…", publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…", alg: "ECDSA-P256-SHA256", label: "办公室 Chrome", connected: true },
};

export const PANELS: PanelSpec[] = [
  { id: "agora.task", source: "agora", title: "任务详情", placement: "node", appliesTo: { kinds: ["session"], sources: ["agora"] }, revision: 1 },
];

export const PANEL_CONTENT: Record<string, PanelContent> = {
  "agora:session:as_a1": { type: "keyValue", rows: [
    { key: "状态", value: "运行中 · 第 2 代" },
    { key: "管理方", value: "用户" },
    { key: "模型", value: "claude-opus-5-5 · standard" },
    { key: "worktree", value: ".agora/wt/as_a1（分支 agora/as_a1）" },
    { key: "本任务用量", value: "182.4k tokens（输入 150.1k，输出 32.3k）" },
    { key: "含子任务", value: "241.0k tokens" },
    { key: "预算", value: "241.0k / 1.0M（24%）" },
    { key: "上下文", value: "46%（92k / 200k）" },
    { key: "第 1 代", value: "完成 · 用户返工：补 children() 分页合并" },
    { key: "第 2 代", value: "进行中，开始于 15:18" },
  ] },
  "agora:session:as_b2": { type: "keyValue", rows: [
    { key: "状态", value: "等待中 · 等待用户答复提问" },
    { key: "管理方", value: "Agent（召集人：实现会话树按需加载）" },
    { key: "模型", value: "claude-sonnet-5 · light" },
    { key: "本任务用量", value: "38.2k tokens" },
    { key: "提问", value: "已转交给你，见左侧待处理" },
  ] },
  "agora:session:as_a3": { type: "keyValue", rows: [
    { key: "状态", value: "失败 · 第 1 代" },
    { key: "管理方", value: "用户" },
    { key: "模型", value: "claude-opus-5-5 · standard" },
    { key: "worktree", value: ".agora/wt/as_a3（未清理）" },
    { key: "本任务用量", value: "96.7k tokens（输入 81.0k，输出 15.7k）" },
    { key: "预算", value: "96.7k / 500k（19%）" },
    { key: "第 1 代", value: "失败：npm test 有 2 项未通过（banner-store.test.mjs）" },
    { key: "答复过的提问", value: "“横幅超过 64 条怎么办” — 由你答复，办公室 Chrome 设备确认" },
  ] },
};

/** 主会话里的工具卡片：agora_task spawn 产生的任务节点用 originToolCall 指向这里。 */
export const SPAWN_CALLS = [
  { id: "tc_spawn_1", nodeId: "agora:session:as_a1", args: { action: "spawn", title: "实现会话树按需加载", model: "claude-opus-5-5" } },
  { id: "tc_spawn_2", nodeId: "agora:session:as_a2", args: { action: "spawn", title: "待处理区与表单弹窗", model: "claude-opus-5-5" } },
  { id: "tc_spawn_3", nodeId: "agora:session:as_a3", args: { action: "spawn", title: "横幅落盘与恢复", model: "claude-opus-5-5" } },
];

/** 运行中子会话的条目（② 用户聊天视图）与进行中的助手消息。 */
export const SUB_ENTRIES: any[] = [
  { type: "message", id: "e1", parentId: null, message: { role: "user", content: "任务书：在 packages/web 实现会话树的按需加载。tree.snapshot 只给热节点，展开节点时调 tree.children 分页；未加载的子节点折叠成“历史（N）”。修订号规则见 plugin-api.md“同步”。" } },
  { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [
    { type: "thinking", thinking: "先看现有 Sidebar 和 session.ts 的数据流。" },
    { type: "text", text: "先读现有的侧栏实现和协议类型。" },
    { type: "toolCall", id: "t1", name: "read", arguments: { path: "packages/web/src/components/Sidebar.tsx" } },
  ] } },
  { type: "message", id: "e3", parentId: "e2", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "// 侧栏：按项目分组的会话列表 …" }] } },
  { type: "message", id: "e4", parentId: "e3", message: { role: "assistant", content: [
    { type: "text", text: "侧栏现在直接渲染 `sessionList`。我把树状态放进新的 `TreeStore`：按来源保存 `epoch`、`revision` 和 tombstone，`upsert` 只在修订号更大时应用。" },
    { type: "toolCall", id: "t2", name: "edit", arguments: { path: "packages/web/src/lib/tree-store.ts", edits: [{ oldText: "  apply(change: TreeChange) {", newText: "  apply(change: TreeChange) {\n    if (change.type === \"reset\") return this.reset(change.epoch);" }] } },
  ] } },
  { type: "message", id: "e5", parentId: "e4", message: { role: "toolResult", toolCallId: "t2", toolName: "edit", content: [{ type: "text", text: "已修改 1 处" }] } },
];
export const SUB_STREAM: InFlightBlock[] = [
  { type: "thinking", contentIndex: 0, text: "children() 返回的页可能比订阅旧，合并时要按修订号比较。", done: true },
  { type: "text", contentIndex: 1, text: "`children()` 的页按同样的修订号规则合并：页里比本地旧的节点不覆盖订阅推来的新内容。下面跑一遍相关测试：", done: true },
  { type: "toolCall", contentIndex: 2, id: "t3", toolName: "bash", argsText: "", args: { command: "node --test test/web/tree-store.test.mjs" }, done: true },
];
export const SUB_RUNNING = new Map([["t3", { partialResult: { content: [{ type: "text", text: "▶ TreeStore\n  ✔ 旧修订号不覆盖新节点 (1.2ms)\n  ✔ tombstone 阻止复活 (0.4ms)\n" } ] } }]]);

export const ASK_ENTRIES: any[] = [
  { type: "message", id: "a1", parentId: null, message: { role: "user", content: "任务书：调研会话树在 500 个以上节点时的渲染方式，比较两三种做法，给出推荐。" } },
  { type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [
    { type: "text", text: "在 Chrome 里用 2000 个节点测了三种做法：定高虚拟列表首帧 9ms，@tanstack/virtual 11ms，不做虚拟化 140ms。选哪种取决于是否要支持变高行，这需要召集人决定。" },
    { type: "toolCall", id: "k1", name: "agora_ask", arguments: { question: "会话树节点超过 500 个时用哪种方式渲染？" } },
  ] } },
];

export const FAILED_ENTRIES: any[] = [
  { type: "message", id: "f1", parentId: null, message: { role: "user", content: "任务书：persistent 横幅写入数据目录的 banners.json（写临时文件后原子替换），pi-pane 重启后恢复。" } },
  { type: "message", id: "f2", parentId: "f1", message: { role: "assistant", content: [
    { type: "text", text: "实现完成，运行测试。" },
    { type: "toolCall", id: "u1", name: "bash", arguments: { command: "npm test -- test/server/banner-store.test.mjs" } },
  ] } },
  { type: "message", id: "f3", parentId: "f2", message: { role: "toolResult", toolCallId: "u1", toolName: "bash", isError: true, content: [{ type: "text", text: "✖ 写盘失败时保留旧文件\n✖ Windows 上替换被占用的文件\n2 项未通过" }] } },
  { type: "message", id: "f4", parentId: "f3", message: { role: "assistant", stopReason: "error", errorMessage: "子代理达到本代的工具调用上限（80 次）", content: [
    { type: "text", text: "Windows 上 `rename` 目标被占用时会失败，需要重试或改用 `ReplaceFileW`。我已用完本代的工具调用次数，请返工时说明要用哪种方式。" },
  ] } },
];

export const MAIN_ENTRIES: any[] = [
  { type: "message", id: "m1", parentId: null, message: { role: "user", content: "M3 前端拆成几个子任务派出去：会话树按需加载、待处理区、横幅落盘、设备密钥迁移。" } },
];
