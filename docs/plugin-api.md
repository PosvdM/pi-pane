# 插件接口

> 状态：设计草案，P0 后冻结。

pi-pane 的插件运行在服务端，通过通用接口向界面提供会话树节点、会话视图、面板、动作、表单和通知。pi-pane 本身不认识插件的业务（如子代理、会议）。

**数据类型的定义以 pi-agora 仓库的 `docs/integration.md` 为准**（“pane 协议 v1”各节：`TreeNode`、`SessionSnapshot`、`SessionStreamEvent`、`PanelSpec`、`PanelContent`、`ActionSpec`、`FormSpec`、`PaneNotification` 等）。本文不重复字段定义，只说明 pi-pane 一侧：插件怎么加载、要实现哪些方法、界面怎么渲染，以及 pi 原生扩展 UI 怎么适配。`packages/plugin-api` 按 integration.md 导出这些类型。

## 插件的加载

- 只加载可信插件：`~/.pi/pane/config.json` 的 `plugins` 里显式列出的 npm 包名或本地路径。

  ```json
  { "plugins": ["@pi-agora/pane-plugin", "D:/dev/my-pane-plugin"] }
  ```

- 插件包在 `package.json` 里声明入口和协议版本：

  ```json
  { "name": "@pi-agora/pane-plugin", "piPane": { "entry": "./dist/plugin.js", "paneProtocol": [1, 1] } }
  ```

- pi-pane 启动时逐个加载。`paneProtocol` 与自己支持的范围没有交集时拒绝加载，在设置页显示原因。
- 插件运行在 pi-pane 服务端进程内，有相同的系统权限，所以只加载可信来源。
- 插件只能提供声明式 UI，不能向浏览器注入脚本或样式。

## 插件要实现的接口

```ts
// 草案，P0 后冻结
import type {
  TreeSnapshot, TreeChange, SessionRef, SessionSnapshot, SessionStreamEvent,
  PanelSpec, PanelContent, ActionSpec, ActionInvocation, ActionResult,
  FormSpec, FormOutcome, PaneNotification,
} from "@pi-pane/plugin-api";

export interface PanePlugin {
  id: string;                         // 即 TreeNode.source，如 "agora"
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
    invoke(inv: ActionInvocation): Promise<ActionResult>;
  };
  forms?: {
    pending(): Promise<FormSpec[]>;                         // 仍待用户填写的持久表单
    submit(formId: string, outcome: FormOutcome): Promise<void>;
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
```

- 插件的每个方法单次调用超时 10 秒；超时或抛出异常时，pi-pane 在对应位置显示错误，不影响主会话。
- `subscribe` 返回的函数用于取消订阅；浏览器全部断开后 pi-pane 会取消订阅。

## 会话树

- 侧栏的树由 pi-pane 自己的节点和各插件的节点合并而成。
- pi-pane 为每个主会话提供节点：`id = "pane:session:<piSessionId>"`、`source = "pane"`、`kind = "session"`，按项目分组。插件可以把这个 id 作为自己节点的 `parentId`，把子会话挂在主会话下面。
- 渲染规则：
  - 按 `parentId` 缩进；同一父节点下按 `sortKey` 升序。
  - `badge` 显示为标题后的标签；`status` 显示为图标（运行中为动画）；`messageCount` 有值时显示在右侧。
  - `availability = archived` 的节点标题用次要颜色；`missing` 显示删除线和“存档缺失”提示。
  - `parentId` 找不到对应节点或形成循环时，节点挂到“未归属”分组。
- 点击节点：
  - `kind = session` 且有 `open` → 在主区域打开会话视图；
  - `kind = group` → 展开或折叠，并打开 `placement = node` 的面板（如有）；
  - `kind = resource` → 打开该资源适用的面板。

## 会话视图

插件提供的会话（如子代理）和主会话使用同一套聊天组件渲染：

- 打开时调 `sessions.snapshot(ref)`，再以快照的 `seq` 调 `sessions.subscribe`（节点带 `subscribe` 能力时）。
- `readonly: true` 或节点没有 `send` 能力时不显示输入框。
- `unfinishedPartials` 显示在对话末尾，标注“中断时正在生成的内容”。
- 节点的 `action:*` 能力显示为视图顶部的按钮（如“返工”“停止”）。

## 面板

- `placement = "sidebar"` 的面板显示在侧栏树下方，标题带 `badgeCount`。
- `placement = "node"` 的面板在打开适用类型的节点时显示在会话视图右侧（或代替会话视图，用于 group 和 resource 节点）。
- 内容按需拉取：显示时调用 `panels.content()`；插件调用 `ctx.panelChanged()` 后，正在显示的面板重新拉取。
- `PanelContent` 的每种 `type` 由 pi-pane 内置组件渲染：`markdown`、`keyValue`、`table`（带行动作）、`list`（带项动作）、`timeline`（按序号的记录，支持向上加载更多）。不认识的 `type` 显示“此面板需要更新的 pi-pane”。

## 动作

- `scope = "node"` 的动作显示在节点的右键菜单和会话视图顶部；`panelRow` 显示在面板行上；`global` 显示在侧栏的“＋”菜单里。
- 点击后：有 `confirm` 先确认；有 `form` 先弹表单；然后调用 `actions.invoke()`。
- pi-pane 为每次点击生成 `idempotencyKey`，同一次点击的重试使用同一个 key。
- `ActionResult.message` 显示为通知；`followUpForm` 继续弹出表单；`openNodeId` 打开对应节点。

## 表单（多题提问）

`FormSpec` 支持最多 5 道选择题（单选、多选、带推荐项、带“其他”自由输入、按前一题答案显示）和自由字段（文本、多行文本、数字、下拉、复选）。

- 插件主动发起的持久表单（如 agora 转给用户的提问）：插件调用 `ctx.formAdded()`；pi-pane 在“待处理”位置列出，并弹出通知。用户提交或取消后调用 `forms.submit()`。浏览器关闭后再打开，`forms.pending()` 的表单仍会列出。
- 动作附带的表单：结果作为 `ActionInvocation.input` 传给插件。
- 取消、过期必须作为明确结果返回，插件不得视为同意。

### 主会话里的扩展使用多题表单

pi 原生扩展 UI 在 RPC 模式下只有 select、confirm、input、editor 四种对话框（依据：pi `docs/rpc-extension-ui.md`），没有多题表单。主会话里的 pi 扩展需要多题表单时，通过 pane-bridge 扩展：

- pane-bridge 在同一 pi 进程里监听 `pi.events`（进程内事件总线，依据：`dist/core/event-bus.d.ts`）：

  ```ts
  // 其他扩展：草案
  pi.events.emit("pane:form:request", { requestId, spec /* FormSpec */ });
  pi.events.on("pane:form:response", ({ requestId, outcome /* FormOutcome */ }) => { … });
  ```

- pane-bridge 通过 loopback HTTP 把表单交给 pi-pane 服务端（凭证为拉起子进程时经环境变量传入的一次性 ticket，兑换后从 `process.env` 删除），浏览器渲染、用户提交后原路返回。
- 判断是否在 pi-pane 里运行：扩展发 `pane:ping`，100 毫秒内收到 `pane:pong` 即可用；否则退回逐题调用 `ctx.ui.select` / `ctx.ui.input`。
- 这类表单是临时的：子进程重启后未完成的表单标记为取消，不自动重问。

## 通知

- `ctx.notify()` 的通知显示在右上角；`level = error` 或 `sticky = true` 的需要手动关闭。
- 相同 `id` 只显示一次。
- `nodeId` 有值时点击打开该节点；`actions` 显示为通知上的按钮。

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

## 与 pi-agora 的集成

pi-agora 提供 `@pi-agora/pane-plugin`，实现上述接口：子代理、会议、参会者、书记、board 在树中的位置，“待处理”面板，返工、停止、答复、召集会议等动作，以及 daemon 不在线时的存档读取。具体映射和 daemon API 见 pi-agora 仓库的 `docs/integration.md`，本文不重复定义。
