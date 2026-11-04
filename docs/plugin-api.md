# 插件接口与 pane 协议

> 状态：设计草案，P0 后冻结。

pi-pane 的插件运行在服务端，通过通用接口向界面提供会话树节点、会话视图、面板、动作、表单和通知。pi-pane 本身不认识插件的业务（如子代理、会议）。

**本文是 pane 协议的权威定义**，供所有插件使用：数据类型、字段规则、渲染规则、同步规则和版本号都以本文为准。`packages/plugin-api`（`@pi-pane/plugin-api`）按本文导出 TypeScript 类型。插件（包括 pi-agora 的 pane 插件）引用本文，不另行定义这些类型。

当前协议版本：**pane 协议 v1**。

## 插件的加载

- 只加载可信插件：`~/.pi/pane/config.json` 的 `plugins` 里显式列出的 npm 包名或本地路径。

  ```json
  { "plugins": ["@pi-agora/pane-plugin", "D:/dev/my-pane-plugin"] }
  ```

- 插件包在 `package.json` 里声明入口和支持的协议版本：

  ```json
  { "name": "@pi-agora/pane-plugin", "piPane": { "entry": "./dist/plugin.js", "paneProtocol": [1, 1] } }
  ```

- 插件把 `@pi-pane/plugin-api` 声明为 peer 依赖，不打包自己的副本。
- pi-pane 启动时逐个加载。`paneProtocol` 与自己支持的范围没有交集时拒绝加载，在设置页显示原因，见“版本”。
- 插件运行在 pi-pane 服务端进程内，有相同的系统权限，所以只加载可信来源。
- 插件只能提供声明式 UI，不能向浏览器注入脚本或样式。

## 插件要实现的接口

```ts
// 草案，P0 后冻结
export interface PanePlugin {
  id: string;                         // 即 TreeNode.source，如 "agora"；"pane" 保留给 pi-pane 自己
  paneProtocol: [number, number];
  activate(ctx: PaneHostContext): Promise<void>;
  deactivate?(): Promise<void>;

  tree?: {
    snapshot(): Promise<TreeSnapshot>;
    subscribe(fromRevision: number, emit: (c: TreeChange) => void): () => void;
  };
  sessions?: {
    snapshot(ref: SessionRef): Promise<SessionSnapshot>;
    subscribe(ref: SessionRef, afterSeq: number, emit: (e: SessionStreamEvent) => void): () => void;
  };
  panels?: {
    list(): PanelSpec[];
    content(panelId: string, nodeId?: string): Promise<PanelContent>;
  };
  actions?: {
    list(): ActionSpec[];
    invoke(inv: ActionInvocation, origin: RequestOrigin): Promise<ActionResult>;
  };
  forms?: {
    pending(): Promise<FormSpec[]>;   // 仍待用户填写的持久表单
    submit(formId: string, outcome: FormOutcome, origin: RequestOrigin): Promise<void>;
  };
}

export default function createPlugin(): PanePlugin;
```

pi-pane 提供给插件的上下文：

```ts
// 草案，P0 后冻结
export interface PaneHostContext {
  readonly paneProtocol: number;              // 协商后的版本
  readonly dataDir: string;                   // 插件专用目录：~/.pi/pane/plugins/<id>/
  readonly log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  notify(n: PaneNotification): void;
  panelChanged(panelId: string, revision: number): void;
  formAdded(form: FormSpec): void;            // 有新的持久表单需要用户填写
  formRemoved(formId: string): void;          // 表单已在别处处理（如召集人已答复）
  mainSessions: {
    list(): { ref: SessionRef; nodeId: string; cwd: string; title: string; online: boolean }[];
    onChange(listener: () => void): () => void;
  };
}

/** 由 pi-pane 服务端测得，插件不能伪造；用于审计和来源检查 */
export interface RequestOrigin {
  client: "browser";
  peerPid?: number;      // 发起该 HTTP 请求的本机进程 PID；取不到时省略（获取方式未核实，见下）
  receivedAt: string;
}
```

- 插件的每个方法单次调用超时 10 秒；超时或抛出异常时，pi-pane 在对应位置显示错误，不影响主会话。
- `subscribe` 返回的函数用于取消订阅；浏览器全部断开后 pi-pane 会取消订阅。
- `RequestOrigin.peerPid`：pi-pane 从 loopback TCP 连接的对端端口查出对端进程（Windows 上用 `GetExtendedTcpTable` 一类系统接口，**具体 API 和 Node 中的调用方式未核实**，P0 验证）。插件可以用它判断操作是否来自可疑进程，例如 pi-agora 用它拒绝来自子代理进程树的“用户”操作。

## 公共类型

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionRef { source: string; id: string }   // 主会话：{ source: "pane", id: <piSessionId> }

export type NodeStatus =
  | "idle" | "running" | "waiting" | "paused"
  | "done" | "failed" | "stopped" | "interrupted";
```

## 会话树

侧栏的会话树由 pi-pane 自己的节点和各插件的节点合并而成。节点不一定是会话：例如会议可以是分组节点，共享资料可以是资源节点。

### TreeNode

```ts
// pane 协议 v1，草案，P0 后冻结
export interface TreeNode {
  id: string;                  // 全局唯一，约定以来源为前缀，如 "agora:session:as_c21e"
  source: string;              // 提供该节点的插件 id；pi-pane 自己的节点为 "pane"
  kind: "session" | "group" | "resource";
  parentId: string | null;     // 可以指向其他来源的节点，如 "pane:session:<piSessionId>"
  title: string;
  badge?: string;              // 类型标签，如 "子代理"、"参会"、"书记"
  sessionRef?: SessionRef;     // kind = session 时必填
  resourceRef?: { source: string; type: string; id: string }; // kind = resource 时必填
  status: NodeStatus;
  availability: "online" | "archived" | "missing";
  messageCount?: number;       // 最终消息数，不计流片段；未知时省略
  sortKey: string;             // 同一父节点下按字典序升序排列
  revision: number;            // 节点内容每变化一次 +1
  capabilities: string[];      // 见下表
}
```

字段规则：

- `availability`：`online` 表示可以订阅实时流；`archived` 表示只能读存档（会话已结束，或提供方的后台服务不在线）；`missing` 表示存档不存在。提供方不在线不等于会话失败，节点应保留原 `status`。
- `parentId` 指向的节点不存在时，pi-pane 把节点放到“未归属”分组下，不丢弃。
- pi-pane 检测循环引用，出现循环时把形成循环的节点挂到“未归属”分组并记录警告。
- 挂在树下不代表有读取权限：点开节点时 pi-pane 通过插件请求内容，由插件判断权限。
- `capabilities` 的取值：

  | 值 | 含义 |
  | --- | --- |
  | `open` | 可以打开查看（快照） |
  | `subscribe` | 可以订阅实时流 |
  | `send` | 可以向该会话发消息（pi-pane 显示输入框） |
  | `abort` | 可以中止当前运行 |
  | `action:<actionId>` | 节点上可执行的插件动作 |

  pi-pane 忽略不认识的值。

### pi-pane 自己的节点

- 每个主会话一个节点：`id = "pane:session:<piSessionId>"`、`source = "pane"`、`kind = "session"`，按项目（工作目录）分组。插件把这个 id 作为 `parentId`，就能把自己的节点挂在主会话下面。
- “未归属”分组：`id = "pane:group:unassigned"`。

### 同步

```ts
// pane 协议 v1，草案，P0 后冻结
export interface TreeSnapshot { source: string; revision: number; nodes: TreeNode[] }

export type TreeChange =
  | { type: "upsert"; node: TreeNode }    // 节点 revision 大于本地才替换
  | { type: "remove"; id: string }
  | { type: "reset" };                    // 丢弃该 source 的全部节点，重新取快照
```

- `TreeSnapshot.revision` 是该来源的全局修订号。pi-pane 用它调用 `tree.subscribe(fromRevision, …)`；插件无法从该修订号接续时发 `reset`。
- 插件后台服务断开、恢复时，也应发 `reset`。

### 渲染

- 按 `parentId` 缩进；同一父节点下按 `sortKey` 升序。
- `badge` 显示为标题后的标签；`status` 显示为图标（`running` 为动画）；`messageCount` 有值时显示在右侧。
- `availability = archived` 的节点标题用次要颜色；`missing` 显示删除线和“存档缺失”提示。
- 点击节点：
  - `kind = session` 且有 `open` → 在主区域打开会话视图；
  - `kind = group` → 展开或折叠，并打开适用的 `placement = node` 面板（如有）；
  - `kind = resource` → 打开适用的面板。

## 会话视图

插件提供的会话（如子代理）和主会话使用同一套聊天组件渲染。

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionSnapshot {
  ref: SessionRef;
  messages: unknown[];            // pi AgentMessage，按 pi docs/message-types.md 渲染
  inFlight?: { contentIndex: number; text: string };          // 正在生成的部分
  unfinishedPartials?: { runId: string; text: string }[];     // 进程中断时没写完的内容
  seq: number;                    // 快照对应的事件序号
  status: NodeStatus;
  readonly: boolean;              // true：只能看，不能发消息
}

export interface SessionStreamEvent {
  seq: number;                    // 同一会话内递增
  ref: SessionRef;
  event: { type: string; [k: string]: unknown }; // pi 会话事件（格式见 pi docs/json.md），或 pane_status / resync
}
```

- 打开时调 `sessions.snapshot(ref)`，再以快照的 `seq` 调 `sessions.subscribe`（节点带 `subscribe` 能力时）。
- `message_update` 只带增量，按 `contentIndex` 拼接；收到 `message_end` 后用完整消息替换。
- 收到 `type: "resync"` 时重新取快照。
- `readonly: true` 或节点没有 `send` 能力时不显示输入框。
- `unfinishedPartials` 显示在对话末尾，标注“中断时正在生成的内容”。
- 节点的 `action:*` 能力显示为视图顶部的按钮。

pi-pane 对自己托管的主会话也产生同样形状的快照和事件。

## 面板

```ts
// pane 协议 v1，草案，P0 后冻结
export interface PanelSpec {
  id: string;                          // 建议以插件 id 为前缀，如 "agora.pending"
  source: string;
  title: string;
  placement: "sidebar" | "node";       // sidebar：侧栏固定面板；node：打开节点时显示
  nodeKinds?: TreeNode["kind"][];      // placement = node 时适用的节点类型
  badgeCount?: number;                 // 侧栏标题上的数字
  revision: number;
}

export type PanelContent =
  | { type: "markdown"; markdown: string }
  | { type: "keyValue"; rows: { key: string; value: string }[] }
  | { type: "table"; columns: { key: string; title: string }[]; rows: Record<string, string>[];
      rowActions?: string[] }          // 每行可用的 actionId，调用时 target 为行的 rowId 字段
  | { type: "list"; items: ListItem[] }
  | { type: "timeline"; items: TimelineItem[]; hasMoreBefore: boolean };

export interface ListItem { id: string; title: string; subtitle?: string; badge?: string; nodeId?: string; actions?: string[] }

export interface TimelineItem {        // 按序号排列的记录，如共享讨论板
  id: string;
  seq: number;
  badge: string;
  author: string;
  markdown: string;
  refs?: { id: string; label: string }[];
  note?: string;                       // 附注，如 "已被合并"、"基于旧版本"
  time: string;
}
```

- `sidebar` 面板显示在侧栏树下方，标题带 `badgeCount`；`node` 面板在打开适用类型的节点时显示在会话视图右侧（group 和 resource 节点时代替会话视图）。
- 内容按需拉取：显示时调用 `panels.content()`；插件调用 `ctx.panelChanged()` 后，正在显示的面板重新拉取。
- 每种 `type` 由 pi-pane 内置组件渲染；`timeline` 支持向上加载更多。不认识的 `type` 显示“此面板需要更新的 pi-pane”。

## 动作

```ts
// pane 协议 v1，草案，P0 后冻结
export interface ActionSpec {
  id: string;                    // 建议以插件 id 为前缀，如 "agora.task.stop"
  source: string;
  title: string;                 // 按钮文字
  scope: "node" | "panelRow" | "global";
  confirm?: string;              // 有值时先弹确认框
  danger?: boolean;
  form?: FormSpec;               // 有值时先填表单，答案作为 input 传入
}

export interface ActionInvocation {
  actionId: string;
  target?: string;               // 节点 id 或面板行 id
  input?: FormAnswers;
  idempotencyKey: string;        // pi-pane 生成，同一次点击的重试使用同一个 key
}

export interface ActionResult {
  ok: boolean;
  message?: string;              // 显示为通知
  followUpForm?: FormSpec;       // 需要进一步填写时
  openNodeId?: string;           // 执行后打开的节点
}
```

- `node` 动作显示在节点的右键菜单和会话视图顶部；`panelRow` 显示在面板行上；`global` 显示在侧栏的“＋”菜单里。
- 点击后：有 `confirm` 先确认；有 `form` 先弹表单；然后调用 `actions.invoke()`，附上 `RequestOrigin`。
- 业务处理在插件服务端完成，浏览器不直接改状态。

## 表单

```ts
// pane 协议 v1，草案，P0 后冻结
export interface FormSpec {
  id: string;
  source: string;
  title: string;
  description?: string;          // Markdown
  questions: FormQuestion[];     // 0–5 道选择题
  fields?: FormField[];          // 自由填写的字段；与 questions 可同时存在
  submitLabel?: string;
  expiresAt?: string;
}

export interface FormQuestion {
  id: string;
  question: string;              // Markdown
  header?: string;
  detail?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; recommended?: boolean; preview?: string }[];
  allowCustom?: boolean;         // 默认 true：允许“其他”自由输入
  dependsOn?: { questionId: string; value?: string | string[] };  // 前一题答案匹配时才显示
}

export interface FormField {
  id: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "checkbox";
  required?: boolean;
  options?: string[];            // type = select
  default?: string;
}

export interface FormAnswers {
  answers: { id: string; selected: string[]; custom?: string }[];
  fields?: Record<string, string>;
}

export type FormOutcome =
  | { status: "submitted"; values: FormAnswers }
  | { status: "cancelled" }
  | { status: "expired" };
```

- **持久表单**（如插件转给用户的提问）：插件调用 `ctx.formAdded()`；pi-pane 在侧栏“待处理”位置列出并弹出通知；用户提交或取消后调用 `forms.submit()`。浏览器关闭后再打开，`forms.pending()` 返回的表单仍会列出。
- **动作附带的表单**：结果作为 `ActionInvocation.input` 传给插件。
- 取消和过期是明确的结果，插件不得当作同意。

### 主会话里的扩展使用多题表单

pi 原生扩展 UI 在 RPC 模式下只有 select、confirm、input、editor 四种对话框（依据：pi `docs/rpc-extension-ui.md`），没有多题表单。主会话里的 pi 扩展需要多题表单时，通过 pane-bridge 扩展：

- pane-bridge 在同一 pi 进程里监听 `pi.events`（进程内事件总线，依据：pi `dist/core/event-bus.d.ts`）：

  ```ts
  // 其他扩展：草案
  pi.events.emit("pane:form:request", { requestId, spec /* FormSpec */ });
  pi.events.on("pane:form:response", ({ requestId, outcome /* FormOutcome */ }) => { … });
  ```

- pane-bridge 通过 loopback HTTP 把表单交给 pi-pane 服务端（凭证为拉起子进程时经环境变量传入的一次性 ticket，兑换后从 `process.env` 删除），浏览器渲染、用户提交后原路返回。
- 判断是否在 pi-pane 里运行：扩展发 `pane:ping`，100 毫秒内收到 `pane:pong` 即可用；否则退回逐题调用 `ctx.ui.select` / `ctx.ui.input`。
- 这类表单是临时的：子进程重启后未完成的表单标记为取消，不自动重问。

## 通知

```ts
// pane 协议 v1，草案，P0 后冻结
export interface PaneNotification {
  id: string;                    // 去重用，同 id 只显示一次
  source: string;
  level: "info" | "warning" | "error";
  title: string;
  body?: string;                 // Markdown
  nodeId?: string;               // 点击后打开的节点
  actions?: string[];            // 通知上的动作按钮（actionId）
  sticky?: boolean;              // true：需要用户手动关闭
}
```

通知显示在右上角；`level = error` 或 `sticky = true` 的需要手动关闭。

## pi 原生扩展 UI 的适配

主会话里的 pi 扩展调用 `ctx.ui.*` 时，pi 在 RPC 模式下发出 `extension_ui_request`（依据：pi `docs/rpc-extension-ui.md`），pi-pane 转给浏览器：

| pi 方法 | 浏览器中的表现 | 回应 |
| --- | --- | --- |
| `select` | 单选对话框 | `{ value }` 或 `{ cancelled: true }` |
| `confirm` | 确认对话框 | `{ confirmed }` 或 `{ cancelled: true }` |
| `input` | 单行输入对话框 | `{ value }` 或 `{ cancelled: true }` |
| `editor` | 多行编辑对话框（带预填内容） | `{ value }` 或 `{ cancelled: true }` |
| `notify` | 通知（`notifyType` 对应 level） | 无 |
| `setStatus` | 会话底部状态栏的一项（按 key） | 无 |
| `setWidget` | 输入框上方或下方的文本块（按 key，只支持字符串数组） | 无 |
| `setTitle` | 浏览器标签页标题 | 无 |
| `set_editor_text` | 替换输入框内容 | 无 |

- 对话框带 `timeout` 时，pi 会在超时后自行按默认值返回（依据同上）；pi-pane 同步关闭对话框并提示“已超时”。
- 没有浏览器连接时，对话框保持待回应，下次打开该会话时弹出。
- 多个标签页同时打开同一会话：所有标签页显示对话框，第一个回应生效，其余自动关闭。
- 不支持的方法（`custom()`、`setFooter`、`setHeader`、组件形式的 `setWidget` 等）在 RPC 模式下由 pi 降级处理，pi-pane 不做额外适配。

## 版本

pane 协议的版本由 pi-pane 定义和维护：

- pi-pane 声明自己支持的范围（当前 `[1, 1]`），插件在 `package.json` 和 `PanePlugin.paneProtocol` 里声明自己的范围；取交集中的最大值作为协商结果，通过 `ctx.paneProtocol` 告诉插件。没有交集时拒绝加载。
- 新增可选字段、新增 `capabilities` 值、新增 `PanelContent.type` 不升版本；pi-pane 忽略不认识的字段和能力值。删除字段或改变字段语义才升版本，pi-pane 至少同时支持当前和上一个版本。
- 改协议先改本文，再改 `@pi-pane/plugin-api`，并在发布说明里写明。

## 与 pi-agora 的集成

pi-agora 提供 `@pi-agora/pane-plugin`，实现上述接口：子代理、会议、参会者、书记、board 在树中的位置，“待处理”面板，返工、停止、答复、召集会议等动作，以及 agora 后台服务不在线时的存档读取。agora 的数据如何映射到本协议、agora 后台服务的 HTTP API，见 pi-agora 仓库的 `docs/integration.md`。pi-pane 不依赖 pi-agora。
