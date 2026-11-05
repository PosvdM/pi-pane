# 插件接口与 pane 协议

> 状态：设计草案，P0 后冻结。

pi-pane 的插件运行在服务端，通过通用接口向界面提供会话树节点、会话视图、面板、动作、表单、通知和横幅，并可以请求浏览器做用户在场确认。pi-pane 本身不认识插件的业务（如子代理、会议）。

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
- 插件只能提供声明式 UI，不能向浏览器注入脚本或样式。

### 运行方式与超时

插件和 pi-pane 服务端运行在同一个 Node.js 进程里，有相同的系统权限，所以只加载可信来源。

pi-pane 对插件方法的每次调用使用**合作式异步超时**：默认 10 秒（动作可以用 `ActionSpec.timeoutMs` 放宽，最长 60 秒），到时 pi-pane 不再等待结果，在对应位置显示错误或“结果未知”，不影响主会话。这种超时只对异步等待有效：插件里的同步死循环或长时间的同步计算会阻塞整个服务端的事件循环，所有会话的事件转发都会停住。插件应把重计算放到自己的 worker 或子进程里。

pi-pane 是否把每个插件放进独立的 worker 线程隔离，**待定**（P0 后根据 agora 插件的实际负载决定）。

## 插件要实现的接口

```ts
// 草案，P0 后冻结
export interface PanePlugin {
  id: string;                         // 即 TreeNode.source，如 "agora"；"pane" 保留给 pi-pane 自己
  paneProtocol: [number, number];
  activate(ctx: PaneHostContext): Promise<void>;
  deactivate?(): Promise<void>;

  tree?: {
    snapshot(req: TreeSnapshotRequest): Promise<TreeSnapshot>;
    children(parentId: string, page: { epoch: string; cursor?: string; limit: number }): Promise<TreeChildrenPage>;
    subscribe(from: TreeCursor, emit: (c: TreeChange) => void): () => void;
  };
  sessions?: {
    snapshot(ref: SessionRef): Promise<SessionSnapshot>;
    history(ref: SessionRef, page: { before: string; limit: number }): Promise<HistoryPage>;
    subscribe(ref: SessionRef, after: StreamCursor, emit: (e: SessionStreamEvent) => void): () => void;
    send?(ref: SessionRef, input: SessionInput, req: SessionSendRequest): Promise<SendResult>;
    abort?(ref: SessionRef, req: SessionAbortRequest): Promise<AbortResult>;
  };
  panels?: {
    list(): PanelSpec[];
    content(panelId: string, nodeId?: string): Promise<PanelContent>;
  };
  actions?: {
    list(): ActionSpec[];                                          // 静态目录
    resolveForm?(actionId: string, target?: ActionTarget): Promise<FormSpec | null>;
    invoke(inv: ActionInvocation, origin: RequestOrigin): Promise<ActionResult>;
  };
  forms?: {
    pending(): Promise<FormSpec[]>;   // 仍待用户处理的持久表单
    submit(req: FormSubmission, origin: RequestOrigin): Promise<FormSubmitResult>;
  };
  renderers?: {
    customMessages?: CustomMessageRenderer[];
  };
}

export default function createPlugin(): PanePlugin;
```

- `subscribe` 返回的函数用于取消订阅；浏览器全部断开后 pi-pane 会取消订阅。
- 各方法的类型见下文对应章节。

## pi-pane 提供给插件的上下文

```ts
// 草案，P0 后冻结
export interface PaneHostContext {
  readonly paneProtocol: number;              // 协商后的版本
  readonly dataDir: string;                   // 插件专用目录：~/.pi/pane/plugins/<id>/，仅当前用户可访问
  readonly log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  notify(n: PaneNotification): void;
  panelChanged(update: PanelUpdate): void;
  formAdded(form: FormSpec): void;            // 新的持久表单，或同一 id 的更高 revision
  formRemoved(formId: string, reason: FormRemovedReason): void;
  setBanner(banner: PaneBanner): void;        // 新增或替换同 id 的横幅，见“横幅”
  clearBanner(id: string): void;
  listBanners(): PaneBanner[];               // 本插件当前的横幅
  mainSessions: MainSessionsApi;
  userPresence: UserPresenceApi;
}

export interface MainSessionsApi {
  list(): MainSessionInfo[];                  // 当前托管中（有 pi 进程）的主会话
  get(piSessionId: string): MainSessionInfo | undefined;   // 任何在 pi 会话存储里列得出的主会话
  onChange(listener: () => void): () => void;
  hold(ref: SessionRef, reason: string): () => void;       // 返回 release()
}

export interface MainSessionInfo {
  ref: SessionRef;                            // { source: "pane", id: <piSessionId> }
  nodeId: string;                             // "pane:session:<piSessionId>"
  cwd: string;
  sessionFile: string;
  title: string;
  hosted: boolean;                            // 是否有 pi 进程
  status: NodeStatus;
}
```

### 保活

`mainSessions.hold(ref, reason)` 让主会话的 pi 进程不被空闲回收，例如插件在等子代理结果、需要召集人会话保持运行时使用：

- 返回的 `release()` 解除这一次 hold；同一会话可以有多个 hold，全部解除后才恢复正常的空闲回收计时。
- `reason` 是给用户看的短句，如“等待子代理”。被 hold 的会话在树节点和会话视图底部显示原因。
- hold 只阻止空闲回收，不会拉起没有运行的会话；对未托管的会话调用时，hold 先登记，会话被拉起后生效。
- 用户在界面上主动关闭被 hold 的会话时，pi-pane 列出 hold 原因请用户确认，确认后照常关闭，并通知持有者（`release()` 变为空操作）。
- 插件 `deactivate` 或卸载时，它持有的 hold 全部解除（它设置的非 persistent 横幅也同时移除，persistent 横幅保留，见“横幅”）。

### 请求来源

```ts
// 草案，P0 后冻结
/** 由 pi-pane 服务端填写，插件不能伪造；用于审计和把确认请求路由回发起的标签页 */
export interface RequestOrigin {
  client: "browser";
  connectionId: string;  // 发起请求的浏览器标签页连接
  deviceId?: string;     // 该标签页登录时报告的设备密钥 id；只用于显示和路由，不是身份证明
  receivedAt: string;
}
```

pi-pane 的 HTTP 接口只接受已登录浏览器的请求（见 [architecture.md](architecture.md#鉴权)），所以带 `RequestOrigin` 的调用都来自浏览器。`deviceId` 不经验证，需要证明“是用户本人在浏览器里操作”时用 `userPresence.confirm`。

pi-pane 不检查请求对端进程（PID），`RequestOrigin` 里没有这类字段。

## 用户在场确认

`userPresence` 是通用能力：插件交给浏览器一段数据，浏览器弹出确认框，用户点击确认后用本浏览器的设备密钥签名。pi-pane 不理解被签名数据的含义，签名由插件的后台服务验证。例如 pi-agora 用它确认答复提问、会议决定、追加预算、批准新设备等用户级操作，挑战内容和设备的 TOFU/批准由 agora 定义（见 pi-agora 仓库的文档）。

```ts
// 草案，P0 后冻结
export interface UserPresenceApi {
  devices(): PresenceDevice[];                       // 当前已登录的浏览器设备
  onDevicesChange(listener: () => void): () => void;
  confirm(req: UserPresenceRequest): Promise<UserPresenceProof>;
}

export interface UserPresenceRequest {
  title: string;
  summary: string;              // Markdown，说明用户在确认什么
  payload: unknown;             // 要签名的 JSON 值，由插件定义
  origin?: RequestOrigin;       // 有值时优先在发起请求的标签页弹出
  timeoutMs?: number;           // 默认 120000，最长 600000
}

export interface UserPresenceProof {
  deviceId: string;
  publicKey: string;            // SPKI，base64url
  alg: "ECDSA-P256-SHA256";
  signature: string;            // base64url
}

export interface PresenceDevice {
  deviceId: string;
  publicKey: string;            // SPKI，base64url
  alg: "ECDSA-P256-SHA256";
  label: string;                // 用户在设置页起的名字，如“办公室 Chrome”
  connected: boolean;
}

/** confirm 失败时 reject 的错误 */
export interface UserPresenceError extends Error {
  code: "rejected" | "timeout" | "noDevice" | "unsupported";
}
```

### 签名格式

- 算法：ECDSA P-256 + SHA-256（WebCrypto `{ name: "ECDSA", namedCurve: "P-256" }`，签名时 `hash: "SHA-256"`）。
- 签名对象：UTF-8 编码的规范 JSON `{ "domain": "pi-pane/user-presence/v1", "payload": <payload> }`。规范 JSON 按 RFC 8785（JCS）：键按 UTF-16 码元排序、无多余空白、数字按 JCS 规则输出。`payload` 必须是可 JSON 表示的值（不含 `undefined`、`NaN`、`Infinity`）。
- `signature` 是 WebCrypto 输出的 IEEE P1363 格式（r‖s，64 字节）再做 base64url。在 Node.js 里验签要指定 `dsaEncoding: "ieee-p1363"`。
- `publicKey` 是 SPKI DER 的 base64url；`deviceId` 是 `publicKey` 对应 SPKI 字节的 SHA-256 的 base64url。验证方应以自己记录的公钥为准，不依赖这个推导关系。
- `domain` 固定，防止同一把设备密钥的签名被挪作他用。

### 确认流程

1. 插件调用 `confirm`。没有已登录的浏览器连接时，立即以 `noDevice` 失败。
2. 带 `origin` 且该标签页仍连接时，只在该标签页弹出；否则在所有已登录的标签页弹出，第一个确认的生效，其余关闭。
3. 确认框显示 `title`、`summary`、发起的插件名，以及可展开的 `payload` 原文。用户点“确认”后浏览器签名并返回；点“拒绝”以 `rejected` 失败；超时以 `timeout` 失败；浏览器不支持 WebCrypto ECDSA 或 IndexedDB 时以 `unsupported` 失败。
4. 确认框不会自动确认，也不能由插件或服务端代为点击。

### 设备密钥

设备密钥由 pi-pane 前端管理：

- 浏览器第一次登录 pi-pane 时用 WebCrypto 生成 ECDSA P-256 密钥对，私钥 `extractable: false`，存入 IndexedDB。页面脚本只能用它签名，读不出私钥。
- 设置页显示本设备的 `deviceId`（缩写）、名称，可以改名；“重置设备密钥”删除旧密钥并生成新的，插件后台服务会把它当作新设备。
- IndexedDB 按源隔离。pi-pane 只在规范源 `http://127.0.0.1:<port>` 上提供服务（见 [architecture.md](architecture.md#鉴权)），端口改变、换浏览器、清除浏览器数据都等于一台新设备，要按插件后台服务的配对流程重新批准。
- 密钥只用于 `userPresence`，不用于登录 pi-pane。

剩余风险见 [architecture.md](architecture.md#剩余风险)。

## 公共类型

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionRef { source: string; id: string }   // 主会话：{ source: "pane", id: <piSessionId> }

export type NodeStatus =
  | "idle" | "running" | "waiting" | "paused"
  | "done" | "failed" | "stopped" | "interrupted";

/** 会话事件流的游标 */
export interface StreamCursor {
  epoch: string;   // 不透明字符串；事件流无法保证连续时更换
  seq: number;     // 同一 epoch 内从 1 递增；0 表示该 epoch 还没有事件
}
```

`NodeStatus` 的含义：`waiting` 表示在等外部条件（排队等名额、等用户回应、等子任务），`paused` 表示被暂停、需要人工恢复，`interrupted` 表示进程意外退出、可以恢复。

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
  statusDetail?: string;       // 状态说明，如 "排队中：第 2 位"
  availability: "online" | "archived" | "missing";
  hasChildren: boolean;
  childCount?: number;         // 已知时填写
  lastActivityAt?: string;     // 用于判断“最近”
  messageCount?: number;       // 最终消息数，不计流片段；未知时省略
  sortKey: string;             // 同一父节点下按字典序升序排列
  revision: number;            // 最后一次修改该节点时的来源级 revision
  capabilities: string[];      // 见下表
  composer?: { actionId: string; placeholder?: string; images?: boolean };  // 见“向会话发消息”
  originToolCall?: { sessionRef: SessionRef; toolCallId: string };         // 见“工具卡片链接”
}
```

字段规则：

- `availability`：`online` 表示可以订阅实时流；`archived` 表示只能读存档（会话已结束，或提供方的后台服务不在线）；`missing` 表示存档不存在。提供方不在线不等于会话失败，节点应保留原 `status`。
- `parentId` 指向的节点不存在时，pi-pane 把节点放到“未归属”分组下，不丢弃。
- pi-pane 检测循环引用，出现循环时把形成循环的节点挂到“未归属”分组并记录警告。
- 挂在树下不代表有读取权限：点开节点时 pi-pane 通过插件请求内容，由插件判断权限。
- `capabilities` 的取值：

  | 值 | 含义 | 对应的插件方法 |
  | --- | --- | --- |
  | `open` | 可以打开会话视图查看（快照）。只适用于 `kind = session` 的节点 | `sessions.snapshot`、`sessions.history` |
  | `subscribe` | 可以订阅实时流 | `sessions.subscribe` |
  | `send` | 可以向该会话发消息（pi-pane 显示输入框） | `sessions.send`，或 `composer` 指定的动作 |
  | `abort` | 可以停止当前运行 | `sessions.abort` |
  | `action:<actionId>` | 节点上可执行的插件动作 | `actions.invoke` |

  声明了能力但插件没有实现对应方法时，pi-pane 不显示该入口并记录警告。pi-pane 忽略不认识的值。`open`、`subscribe`、`send`、`abort` 只对 session 节点有效，出现在 group 或 resource 节点上时忽略；这两类节点的内容靠适用的面板显示（见“渲染”和“面板”），不需要声明能力。

### pi-pane 自己的节点

- 每个主会话一个节点：`id = "pane:session:<piSessionId>"`、`source = "pane"`、`kind = "session"`。覆盖范围是 pi 会话存储中能列出的全部会话（见 [architecture.md](architecture.md#会话列表)），不只是正在托管的会话，所以插件可以把节点挂到任何一个主会话下。
- 按项目（工作目录）分组：`id = "pane:project:<cwd 规范化后的哈希>"`、`kind = "group"`。
- “未归属”分组：`id = "pane:group:unassigned"`。父节点是 pi-pane 列不出的主会话（例如终端里用 `--session-dir` 指定了别处的会话）时，插件节点进入这个分组。

### 按需加载

会话多了以后不能一次载入整棵树：

- `tree.snapshot(req)` 只返回“热节点”及其全部祖先。热节点是：`req.openNodeIds` 中的节点（浏览器里打开着的）、`status` 为 `running`、`waiting`、`paused` 的节点、`lastActivityAt` 晚于 `req.recentSince` 的节点。
- 其余节点按需加载：用户展开某个节点时，pi-pane 调 `tree.children(parentId, page)` 分页取子节点。
- 每个父节点下，已加载的子节点正常显示，没有加载的折叠为一行“历史（N）”（N 取自父节点的 `childCount`，未知时不显示数字），展开后分页加载。

```ts
// pane 协议 v1，草案，P0 后冻结
export interface TreeSnapshotRequest {
  openNodeIds: string[];
  recentSince: string;         // 默认 7 天前
}

export interface TreeSnapshot {
  source: string;
  epoch: string;               // 修订号序列的标识；插件重建修订号序列时更换
  revision: number;            // 快照对应的来源级修订号
  nodes: TreeNode[];
}

export interface TreeCursor {
  epoch: string;
  revision: number;
}

export type TreeChildrenPage =
  | { epoch: string;           // 必须等于请求里的 epoch
      revision: number;        // 这一页对应的来源级修订号
      nodes: TreeNode[];
      nextCursor?: string }
  | { reset: true; epoch: string };   // 请求的 epoch 已失效
```

### 同步

```ts
// pane 协议 v1，草案，P0 后冻结
export type TreeChange =
  | { type: "upsert"; revision: number; node: TreeNode }
  | { type: "remove"; revision: number; id: string }      // tombstone
  | { type: "reset"; epoch: string };                     // 丢弃该来源的全部节点，重新取快照
```

- **来源级修订号**：每个来源维护一个单调递增的 `revision`，每条 `upsert`/`remove` 都分配一个新值，`node.revision` 等于该节点最后一次 `upsert` 的值。
- **切点**：快照的 `{ epoch: E, revision: R }` 表示快照包含了 epoch E 内修订号不大于 R 的全部变更；`tree.subscribe({ epoch: E, revision: R }, emit)` 必须从 R 之后的第一条变更开始推送，不重不漏。
- **必须 reset 的情况**：`subscribe` 时 `from.epoch` 不是插件当前的 epoch、`from.revision` 大于插件当前最新的修订号、或 `from.revision` 之后的变更已不在缓冲里时，插件先发 `reset`，不发其他变更。`children()` 请求的 `epoch` 不是当前 epoch 时，插件返回 `{ reset: true }`；pi-pane 收到 epoch 与本地不同的页，或页的 `revision` 大于已知的最新修订号且订阅尚未追上时，等订阅追上后再合并，等待超过 5 秒则按 `reset` 处理。
- **tombstone**：`remove` 带修订号。pi-pane 记住被删除的 id 和修订号（保留到下一次 `reset`），之后修订号更小的 `upsert` 不会让它复活。
- **应用规则**：pi-pane 只应用 `revision` 大于本地该节点已知值（含 tombstone）的 `upsert`；`children()` 返回的页按同样的规则合并，页里修订号较旧的节点不覆盖订阅推来的新内容。
- **推送范围**：订阅推送该来源所有节点的变更，不只是已加载的节点。父节点未加载的 `upsert` 只更新父节点的 `hasChildren`/`childCount`；如果节点变成热节点（如开始运行），pi-pane 补取它的祖先后显示。
- **reset**：除上述情况外，插件后台服务断开、恢复，或修订号序列重建（`epoch` 变化）时也发 `reset`。pi-pane 丢弃该来源的节点和 tombstone，重新调用 `snapshot()`，再用新快照的游标订阅。

### 渲染

- 按 `parentId` 缩进；同一父节点下按 `sortKey` 升序。
- `badge` 显示为标题后的标签；`status` 显示为图标（`running` 为动画），`statusDetail` 显示在悬停提示里；`messageCount` 有值时显示在右侧。
- `availability = archived` 的节点标题用次要颜色；`missing` 显示删除线和“存档缺失”提示。
- 点击节点：
  - `kind = session` 且有 `open` → 在主区域打开会话视图；
  - `kind = group` → 展开或折叠，并打开适用的 `placement = node` 面板（如有）；
  - `kind = resource` → 打开适用的面板。

## 会话视图

插件提供的会话（如子代理）和主会话使用同一套聊天组件渲染。

### 三种投影

pi 的会话文件是一棵只追加的条目树（依据：pi `docs/session-format.md`），同一份数据有三种看法：

| 投影 | 内容 | 在 pi-pane 中的用途 |
| --- | --- | --- |
| ① 原始存档 | 全部条目，包括被放弃的分支，条目 id 稳定 | 数据来源；导出 |
| ② 用户聊天视图 | 从当前叶子沿 `parentId` 回到根的整条活动分支，包含压缩前的内容；压缩条目显示为分隔标记，`context_edit` 不改变显示 | 会话视图显示的内容 |
| ③ 模型当前上下文 | 压缩和 `context_edit` 之后模型实际收到的消息 | 只在“模型上下文”详情里显示（不在 MVP） |

- 会话视图只显示 ②。主会话用 RPC `get_entries`（含压缩前历史，支持 `since` 游标，依据：pi `docs/rpc-commands.md`）取 ①，在服务端算出 ②；不用只返回 ③ 的 `get_messages`。
- 插件提供的会话（包括 pi-agora 的在线和离线读取）必须返回同一种 ②：条目保留 pi 的原始形状和 id。
- ② 中的条目按类型显示：`message` 按角色渲染；`custom_message` 见“自定义消息”；`compaction` 显示为“以上内容已压缩”分隔线，可展开摘要；`branch_summary` 显示为折叠卡片；`model_change`、`thinking_level_change` 显示为一行小字；`custom`、`label`、`session_info`、`usage`、`context_edit` 不显示。

### SessionSnapshot

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionSnapshot {
  ref: SessionRef;
  cursor: StreamCursor;           // 快照对应的切点
  leafId: string | null;          // 当前活动分支的叶子条目
  entries: unknown[];             // ② 的最后一页：pi SessionEntry，按分支顺序（旧在前）
  historyBefore: string | null;   // 历史水位：更早的条目从这个条目的父条目开始取；null 表示已到开头
  inFlight?: InFlightState;
  unfinishedPartials?: UnfinishedPartial[];
  status: NodeStatus;
  controlRevision?: number;       // 控制状态的 revision，见“向会话发消息与停止”
  readonly: boolean;              // true：只能看，不能发消息
  readonlyReason?: "archived" | "externalWriter" | "noPermission";
}

export interface HistoryPage {
  entries: unknown[];             // historyBefore 之前的条目，按分支顺序（旧在前）
  historyBefore: string | null;
}

/** 进行中的状态：完整的进行中助手消息 + 工具执行 + 队列 */
export interface InFlightState {
  phase: "idle" | "streaming" | "tools" | "compacting" | "retrying" | "waitingUi" | "stopping";
  assistant?: {
    startedAt: number;
    blocks: InFlightBlock[];      // 按 contentIndex 排列
    usage?: unknown;              // 最近一次 message_update 的 usage
  };
  completed?: unknown[];          // 已收到 message_end、还没有对应条目的消息
  tools: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    partialResult?: unknown;      // 最近一次 tool_execution_update
    startedAt: number;
  }[];
  queue: { steering: string[]; followUp: string[] };   // 最近一次 queue_update
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
}

export type InFlightBlock =
  | { type: "text"; contentIndex: number; text: string; done: boolean }
  | { type: "thinking"; contentIndex: number; text: string; done: boolean }
  | { type: "toolCall"; contentIndex: number; id: string; toolName: string;
      argsText: string;           // 已收到的参数片段（toolcall_delta 拼接）
      args?: unknown;             // toolcall_end 后的完整参数
      done: boolean };

/** 进程中断时没写完的内容，块类型与 InFlightBlock 相同 */
export interface UnfinishedPartial { runId: string; at: string; blocks: InFlightBlock[] }
```

- **切点**：快照的 `entries`、`inFlight` 和 `cursor` 必须是同一时刻的状态，即快照包含了游标之前（含）的全部事件，`subscribe(ref, cursor)` 从下一条事件开始推送。pi-pane 自己的会话怎样保证这一点见 [architecture.md](architecture.md#快照与切点)。
- **历史水位**：`entries` 是从叶子往回的最后一页。翻旧页时调 `history(ref, { before: historyBefore, limit })`，得到水位之前的条目和新的水位。条目树只追加、`parentId` 不变，所以沿父链往回翻得到的页面是确定的；新条目只会出现在叶子之后，由事件流送达。翻页和实时追加不会重复或遗漏。
- **分支切换**：活动分支的叶子移到另一条分支（如 `fork`、树导航）时，提供方发 `resync`，浏览器重新取快照。
- **inFlight**：`assistant.blocks` 由 `message_update` 的 `*_start`/`*_delta`/`*_end` 按 `contentIndex` 重建，`*_end` 和 `message_end` 带来的完整内容替换拼接结果（依据：pi `docs/json.md` 的“Reconstruct streaming messages”）。`tools` 由 `tool_execution_*` 维护，`queue` 由 `queue_update` 维护。
- **图片**：插件返回的条目保持 pi 的原样（图片是 base64 的 `ImageContent`）。pi-pane 服务端在发给浏览器之前把图片换成按哈希的引用，见 [image-placeholders.md](image-placeholders.md#历史消息中的图片)。

### 事件流

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionStreamEvent {
  ref: SessionRef;
  cursor: StreamCursor;
  event: { type: string; [k: string]: unknown };
}
```

`event` 是以下之一：

| type | 内容 |
| --- | --- |
| pi 会话事件 | `message_start`/`message_update`/`message_end`、`tool_execution_*`、`queue_update`、`compaction_*`、`auto_retry_*`、`agent_start`/`agent_end`/`agent_settled` 等，格式见 pi `docs/json.md` |
| `pane_entries` | `{ entries: unknown[]; leafId: string }`：新持久化的条目，按顺序接在当前叶子之后。浏览器用它替换 `inFlight.completed` 中对应的消息（按顺序对应） |
| `pane_status` | 见下 |
| `pane_session_replaced` | `{ newRef: SessionRef; reason: "new" \| "resume" \| "fork" }`：托管进程切换到了另一个会话，见 [architecture.md](architecture.md#会话切换) |
| `resync` | 无字段：浏览器重新取快照 |

```ts
// pane_status 事件，草案，P0 后冻结
export interface PaneStatusEvent {
  type: "pane_status";
  status: NodeStatus;
  phase: InFlightState["phase"];
  controlRevision?: number;                      // 控制状态变化后的新值
  detail?: string;                               // 显示在会话视图底部
  holds?: { source: string; reason: string }[];  // 主会话的保活原因
  readonly?: boolean;
}
```

**游标规则**（pi-pane 自己的会话和插件提供的会话都遵守）：

- `subscribe(ref, after)` 时，`after.epoch` 与当前 epoch 不同、`after.seq` 大于当前最新的 seq，或 `after.seq` 之后的事件已经不在缓冲区里，提供方先发一条 `resync`，不发其他事件。
- 提供方无法保证事件连续时（进程重启、服务重启、托管进程切换会话、缓冲重建）更换 `epoch`，已订阅的连接收到 `resync`。
- epoch 的粒度由提供方决定：可以每次服务启动换一次，也可以每次会话运行或进程重建都换。要求只有一条：同一会话在同一 epoch 内的 `seq` 连续递增、不重用，且任何一个游标之后的事件都能接着快照重放。做不到时（例如进程重建后进行中的状态无法衔接）就必须换 epoch。浏览器只比较 epoch 是否相同，不解析它的内容。pi-pane 自己的主会话在服务端启动、进程重启、进程内切换会话和模型重建时换 epoch（见 [architecture.md](architecture.md#游标与重连)）。
- 浏览器收到 `resync` 后重新取快照，用快照的 `cursor` 重新订阅。

### 显示规则

- 打开时调 `sessions.snapshot(ref)`，再以快照的 `cursor` 调 `sessions.subscribe`（节点带 `subscribe` 能力时）。
- `readonly: true` 或节点没有 `send` 能力时不显示输入框；`readonlyReason = externalWriter` 时显示“该会话可能正在别处运行”和“Fork 为新会话”按钮。
- `unfinishedPartials` 显示在对话末尾，标注“中断时正在生成的内容”，按块类型分别显示思考、文字和工具调用。
- 节点的 `action:*` 能力显示为视图顶部的按钮。

pi-pane 对自己托管的主会话也产生同样形状的快照和事件。

### 向会话发消息与停止

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionInput {
  text: string;
  images?: { mimeType: string; data: string }[];   // base64，按出现顺序
  delivery?: "steer" | "followUp";                 // 会话运行中时由用户选择
}

export type SendResult =
  | { status: "accepted" }
  | { status: "pending" }                                    // 已受理、仍在处理
  | { status: "rejected"; message: string }
  | { status: "conflict"; controlRevision: number; message?: string }  // expectedRevision 不符
  | { status: "idempotencyConflict"; message: string };      // 同一 key、不同内容

export type AbortResult =
  | { status: "done"; clearedText?: string[] }   // clearQueue 为 true 时清出的待发文本，按原顺序
  | { status: "nothingToStop" }
  | { status: "conflict"; controlRevision: number };
```

- `sessions.send` 和 `sessions.abort` 的 `req` 可以带 `expectedRevision`（取自快照或最近一条 `pane_status` 的 `controlRevision`）。提供 `controlRevision` 的插件必须检查它，不符时返回 `conflict`，pi-pane 重新读取状态后请用户确认，处理方式与主会话相同（见 [architecture.md](architecture.md#停止与控制队列)）。不提供 `controlRevision` 的会话不做这项检查。
- `sessions.send` 的幂等规则见“幂等规则”。

TypeScript 签名中 `req` 的完整形状：

```ts
// pane 协议 v1，草案，P0 后冻结
export interface SessionSendRequest { idempotencyKey: string; origin: RequestOrigin; expectedRevision?: number }
export interface SessionAbortRequest { clearQueue: boolean; origin: RequestOrigin; expectedRevision?: number }
```

- 节点有 `send` 能力时，输入框提交调用 `sessions.send`；节点同时有 `composer` 时改为调用 `composer.actionId` 指定的动作，`target` 为该节点，文字放在 `input.fields.message`。例如 pi-agora 把“对子代理发消息”映射到自己的 steer 动作。`composer.images` 不为 `true` 时输入框禁用图片。
- 节点有 `abort` 能力时显示“停止”按钮。“停止”的语义是取消，`clearQueue: true`：插件先清空队列再中止，把清出的文本放进 `clearedText`，pi-pane 放回输入框。语义与主会话一致，见 [architecture.md](architecture.md#停止与控制队列)。

### 自定义消息

扩展用 `pi.sendMessage()` 写入的 `custom` 消息（依据：pi `docs/message-types.md` 的 CustomMessage）按 `customType` 渲染：

```ts
// pane 协议 v1，草案，P0 后冻结
export interface CustomMessageRenderer {
  customType: string;              // 完全匹配，约定以插件 id 为前缀，如 "agora:notice"
  label: string;                   // 卡片标题
  collapsed?: boolean;             // 默认 true
  body?: "content" | "none";       // content：把消息的文字内容按 Markdown 渲染；默认 content
  fields?: { path: string; label: string }[];   // 从 details 中按点分路径取值，显示为键值行
  nodeIdPath?: string;             // details 中节点 id 的路径；有值时卡片可点击打开该节点
}
```

- 有匹配的渲染器时按渲染器显示；多个插件声明同一个 `customType` 时，先加载的生效，其余记录警告。
- 没有渲染器、`display: true`：显示为折叠卡片，标题为 `customType`，展开后显示文字内容。
- `display: false`：默认不显示；设置里打开“显示隐藏消息”后按上一条显示。

### 工具卡片链接

插件节点带 `originToolCall` 时，pi-pane 在对应会话里 `toolCallId` 相同的工具卡片上显示“打开 <节点标题>”链接，点击打开该节点。例如 pi-agora 的任务节点填上召集人会话和 `agora_task` 工具调用的 id，主会话里的工具卡片就能跳到子会话。

## 面板

```ts
// pane 协议 v1，草案，P0 后冻结
export interface PanelSpec {
  id: string;                          // 建议以插件 id 为前缀，如 "agora.board"
  source: string;
  title: string;
  placement: "sidebar" | "node";       // sidebar：侧栏固定面板；node：打开节点时显示
  appliesTo?: {                        // placement = node 时的适用条件；各项同时满足，项内任一匹配
    kinds?: TreeNode["kind"][];
    sources?: string[];                // TreeNode.source
    resourceTypes?: string[];          // TreeNode.resourceRef.type
  };
  badgeCount?: number;                 // 侧栏标题上的数字（初始值）
  revision: number;
}

export interface PanelUpdate {
  panelId: string;
  revision: number;
  nodeId?: string;                     // 只有该节点的内容变了；省略表示全部
  badgeCount?: number | null;          // 有值时更新角标；null 清除
}

export type PanelContent =
  | { type: "markdown"; markdown: string }
  | { type: "keyValue"; rows: { key: string; value: string }[] }
  | { type: "table"; columns: { key: string; title: string }[]; rows: TableRow[] }
  | { type: "list"; items: ListItem[] }
  | { type: "timeline"; items: TimelineItem[]; hasMoreBefore: boolean }
  | { type: "steps"; title?: string; steps: StepItem[]; progress?: { current: number; total: number } };

export interface TableRow {
  rowId: string;                       // 面板内唯一；调用行动作时作为 target.rowId
  cells: Record<string, string>;       // 按 columns[].key 取值
  actions?: string[];                  // 该行可用的 actionId
  nodeId?: string;                     // 该行对应的节点；有值时行可点击打开
}

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

export interface StepItem {            // 有先后顺序的阶段，如会议进度
  id: string;
  title: string;
  status: "pending" | "active" | "done" | "failed" | "skipped";
  detail?: string;                     // Markdown
  nodeId?: string;
  time?: string;
}
```

- `sidebar` 面板显示在侧栏树下方，标题带角标；`node` 面板在打开符合 `appliesTo` 的节点时显示在会话视图右侧（group 和 resource 节点时代替会话视图）。没有 `appliesTo` 的 `node` 面板适用于该插件自己的全部节点。
- 内容按需拉取：显示时调用 `panels.content()`。插件调用 `ctx.panelChanged()` 推送变化：带 `badgeCount` 时立即更新角标；正在显示且受影响的面板重新拉取。
- 每种 `type` 由 pi-pane 内置组件渲染；`timeline` 支持向上加载更多。不认识的 `type` 显示“此面板需要更新的 pi-pane”。
- 面板里的 Markdown 按 [architecture.md](architecture.md#渲染与资源安全) 的规则渲染。

## 幂等规则

适用于带 `idempotencyKey` 的调用：`actions.invoke`、`forms.submit`、`sessions.send`。插件把“操作身份”和“操作当前状态”分开处理：

- **操作身份**：一个 key 对应一次操作。插件记录 key 和调用内容的摘要（`invoke` 为 `actionId`、`target`、`input`、`formId`、`formRevision`；`submit` 为 `formId`、`revision`、`outcome`；`send` 为会话和 `input`）。同一 key 的操作只执行一次。
- **同一 key、同样内容再次调用**：不重新执行，返回该操作的**当前**状态——仍在处理时返回 `pending`，已结束时返回最终结果（成功或失败）。一次操作可以先返回 `pending`、之后返回成功或失败。
- **只缓存最终结果**：`pending` 和超时不是结果，不能作为这个 key 的固定回答缓存下来。最终结果至少保留 24 小时。
- **同一 key、不同内容**：明确拒绝，返回 `idempotencyConflict`，不执行也不返回原操作的结果。
- **超时**：pi-pane 侧的调用超时只表示“暂时不知道结果”，操作可能仍在进行，用同一 key 查询。
- 插件调用自己的后台服务时，把 key 原样作为后台服务的幂等键（pi-agora 放进 `Idempotency-Key` 请求头），让同样的规则延伸到后台。

## 动作

```ts
// pane 协议 v1，草案，P0 后冻结
export interface ActionSpec {
  id: string;                    // 建议以插件 id 为前缀，如 "agora.task.stop"
  source: string;
  title: string;                 // 按钮文字
  scope: ("node" | "panelRow" | "global")[];
  confirm?: string;              // 有值时先弹确认框
  danger?: boolean;
  hasForm?: boolean;             // true：点击时调用 resolveForm 取表单
  timeoutMs?: number;            // invoke 的超时，默认 10000，最长 60000
}

export type ActionTarget =
  | { type: "node"; nodeId: string }
  | { type: "panelRow"; panelId: string; rowId: string; nodeId?: string }
  | { type: "global" };

export interface ActionInvocation {
  actionId: string;
  target?: ActionTarget;
  input?: FormAnswers;
  formId?: string;               // input 对应的表单 id
  formRevision?: number;
  idempotencyKey: string;        // pi-pane 生成，见下
}

export type ActionResult =
  | { status: "ok"; message?: string; openNodeId?: string }
  | { status: "failed"; message: string }
  | { status: "pending"; message?: string }          // 已受理、仍在处理；之后用同一 key 查询
  | { status: "needsInput"; followUpForm: FormSpec } // 需要进一步填写
  | { status: "idempotencyConflict"; message: string }; // 同一 key、不同内容
```

点击流程：

1. 有 `confirm` 先确认。
2. 有 `hasForm` 时调用 `actions.resolveForm(actionId, target)` 按目标取表单（如答复某个提问时题目随提问不同），返回 `null` 表示不需要表单。`actions.list()` 只是静态目录，表单不放在 `ActionSpec` 里。
3. 调用 `actions.invoke()`，附上 `RequestOrigin`。业务处理在插件服务端完成，浏览器不直接改状态。

幂等与超时（通用规则见“幂等规则”）：

- 每次点击生成一个 `idempotencyKey`（随机，至少 128 位），同一次点击的重试和查询使用同一个 key。
- `invoke` 超时时，pi-pane 显示“结果未知”和“查询结果”按钮；“查询结果”用同一个 key 和同样的内容再调用一次 `invoke`，得到这次操作的当前状态。
- 超时不代表失败，也不代表用户拒绝：插件和它的后台服务可能仍在处理（例如等待用户在另一个标签页做 `userPresence` 确认），之后可能成功。pi-pane 不把超时显示为失败。
- 结果为 `needsInput` 时，pi-pane 弹出 `followUpForm`，提交时再次调用 `invoke`：`actionId` 和 `target` 不变，`input` 为新答案，`idempotencyKey = <原 key>/<n>`（n 从 1 递增，沿用原 key 作前缀），`formId`、`formRevision` 取自该表单。
显示位置：`scope` 含 `node` 的显示在节点右键菜单和会话视图顶部（节点 `capabilities` 中列出时）；含 `panelRow` 的显示在面板行上（行 `actions` 中列出时）；含 `global` 的显示在侧栏的“＋”菜单里。

## 表单

```ts
// pane 协议 v1，草案，P0 后冻结
export interface FormSpec {
  id: string;
  source: string;
  revision: number;              // 表单内容每变化一次 +1
  title: string;
  description?: string;          // Markdown
  questions?: FormQuestion[];    // 0–5 道选择题
  fields?: FormField[];          // 自由填写的字段；与 questions 可同时存在
  submitLabel?: string;
  cancel?: { label: string };    // 有值时显示业务“取消”按钮，例如“拒绝此请求”
  createdAt: string;             // ISO 时间；同一 id 的后续 revision 不变
  expiresAt?: string;            // 只用于显示倒计时；是否过期由插件裁定
  nodeId?: string;               // 关联的节点
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
  type: "text" | "textarea" | "number" | "select" | "checkbox" | "group";
  description?: string;
  required?: boolean;
  options?: string[];            // type = select
  default?: string;
  fields?: FormField[];          // type = group：每组包含的子字段
  min?: number;                  // type = group：最少组数，默认 0
  max?: number;                  // type = group：最多组数，默认 1；大于 1 时可重复添加
}

export type FieldValue = string | FieldGroupValue[];        // group 的值是每组一个对象
export interface FieldGroupValue { [fieldId: string]: FieldValue }

export interface FormAnswers {
  answers: { id: string; selected: string[]; custom?: string }[];
  fields?: Record<string, FieldValue>;   // checkbox 的值为 "true" / "false"
}

export type FormOutcome =
  | { status: "submitted"; values: FormAnswers }
  | { status: "cancelled"; reason?: string };   // 业务取消：用户点了 cancel 按钮

export interface FormSubmission {
  formId: string;
  revision: number;              // 用户看到的表单版本
  outcome: FormOutcome;
  idempotencyKey: string;
}

export type FormSubmitResult =
  | { status: "accepted"; message?: string }
  | { status: "pending"; message?: string }          // 已受理、仍在处理（如等待用户在场确认）
  | { status: "alreadyHandled"; message?: string }   // 已在别处处理
  | { status: "stale"; form: FormSpec }               // 表单已更新，请按新版本重填
  | { status: "failed"; message: string }
  | { status: "idempotencyConflict"; message: string };

export type FormRemovedReason = "handled" | "cancelled" | "expired" | "withdrawn";
```

### 持久表单

持久表单是插件交给用户、在用户处理之前一直存在的表单，例如转给用户的提问、会议决策请求、待批准的设备、命令行发起的待确认操作。

- **待处理区**：侧栏只有一个“待处理”区，列出所有插件的持久表单，按插件分组，标题带总数角标。插件不另做“待处理”面板。
- **排序**：组内按 `(createdAt 升序, id 升序)` 排列，这是一个稳定的全序。`forms.pending()` 按同一顺序返回；待处理区不按到达顺序排列，`formAdded` 推来的新表单按 `createdAt`、`id` 插入对应位置，同一 `id` 的更新保持原位置。
- **新增和更新**：插件调用 `ctx.formAdded(form)`；同一 `id` 的更高 `revision` 替换旧版本，较低或相同的 `revision` 忽略，正在填写的用户看到“表单已更新”提示。
- **对齐**：pi-pane 启动和插件重连时调用 `forms.pending()`，以它的结果为准重建该插件的列表：结果里没有的表单移除，`revision` 更高的替换。对齐期间收到的 `formAdded`/`formRemoved` 在对齐完成后按 `revision` 规则再应用一遍。
- **关闭显示（dismiss）**：弹窗右上角的“稍后处理”只关闭弹窗，表单留在待处理区，不通知插件，也不是提交结果。
- **取消（cancel）**：表单带 `cancel` 时显示该按钮，点击后提交 `{ status: "cancelled" }`，这是一个业务结果（如拒绝请求），插件不得当作同意。
- **过期**：由插件（或它的后台服务）统一裁定，到期后调用 `ctx.formRemoved(id, "expired")`。pi-pane 不因为 `expiresAt` 到了就自行移除或提交。
- **并发提交**：同一表单可能在两个标签页、两台设备上同时提交（不同的 `idempotencyKey`）。插件按 `formId` + `revision` 只接受第一个，其余返回 `alreadyHandled`（pi-pane 显示“已处理”并关闭）；`revision` 落后时返回 `stale` 和新表单。同一个 key 的重试按“幂等规则”返回当前状态。
- **等待确认**：`submit` 返回 `pending` 时（如插件在等 `userPresence` 确认或后台处理），表单保持“处理中”，直到插件调用 `formRemoved` 或用同一 key 查询得到最终结果。确认超时不等于拒绝。
- **移除**：插件在表单被处理、取消、过期或撤回后调用 `ctx.formRemoved()`，所有标签页关闭该表单。
- **需要用户在场确认的提交**：插件可以在 `forms.submit()` 里用调用方的 `origin` 调 `ctx.userPresence.confirm()`，确认框出现在提交的那个标签页。

### 动作附带的表单

`resolveForm` 返回的表单和 `followUpForm` 不进待处理区，用户关闭弹窗即放弃这次操作，答案作为 `ActionInvocation.input` 传给插件。

### 主会话里的扩展使用多题表单

pi 原生扩展 UI 在 RPC 模式下只有 select、confirm、input、editor 四种对话框（依据：pi `docs/rpc-extension-ui.md`），没有多题表单。主会话里的 pi 扩展需要多题表单时，通过 pane-bridge 扩展：

- pane-bridge 在同一 pi 进程里监听 `pi.events`（进程内事件总线，依据：pi `dist/core/event-bus.d.ts`）：

  ```ts
  // 其他扩展：草案
  pi.events.emit("pane:form:request", { requestId, spec /* FormSpec */ });
  pi.events.on("pane:form:response", ({ requestId, outcome /* BridgeFormOutcome */ }) => { … });

  type BridgeFormOutcome = FormOutcome | { status: "expired" } | { status: "aborted" };
  ```

- pane-bridge 经回连通道把表单交给 pi-pane 服务端（见 [architecture.md](architecture.md#pane-bridge)），浏览器渲染、用户提交后原路返回。
- 判断是否在 pi-pane 里运行：扩展发 `pane:ping`，100 毫秒内收到 `pane:pong` 即可用；否则退回逐题调用 `ctx.ui.select` / `ctx.ui.input`。
- 这类表单是临时的，不进待处理区：`spec.expiresAt` 到期时 pane-bridge 返回 `expired`；会话被停止、关闭或切换时返回 `aborted`；子进程退出后浏览器里的表单关闭，不自动重问。

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
  actions?: string[];            // 通知上的动作按钮（actionId）；target 为 nodeId 对应的节点
  sticky?: boolean;              // true：需要用户手动关闭
}
```

通知显示在右上角；`level = error` 或 `sticky = true` 的需要手动关闭。通知不持久化，需要用户处理的事项用持久表单，需要持续提示的状态用横幅。

## 横幅

横幅用于插件需要持续提示、用户不能忽略的状态，例如 pi-agora 的“设备记录已被重置”“用户确认保护已关闭”。

```ts
// pane 协议 v1，草案，P0 后冻结
export interface PaneBanner {
  id: string;                    // 在该插件内唯一；不同插件的同名 id 互不影响
  level: "info" | "warning" | "error";
  title: string;                 // 纯文本，紧凑样式下只显示这一行
  body?: string;                 // Markdown，展开后显示
  actions?: string[];            // actionId，调用时 target 为 { type: "global" }
  persistent?: boolean;          // true：pi-pane 落盘保存，重启和插件不可用时都保留，直到插件显式清除
}

/** 发给浏览器的横幅状态 */
export interface BannerState extends PaneBanner {
  source: string;                // 设置它的插件 id
  sourceUnavailable: boolean;    // 来源插件未加载、初始化失败、停用或卸载
}
```

- **显示**：所有已登录标签页的页面顶部常驻，多条时按 `level`（error 在前）、再按设置时间排列。用户不能关闭，只能在紧凑（只显示 `title`）和展开（显示 `body` 和动作按钮）之间切换；切换只影响本标签页。
- **属于服务端状态**：横幅保存在 pi-pane 服务端，新标签页登录后和 WebSocket 重连后自动收到当前全部横幅（见 [architecture.md](architecture.md#websocket)）。
- **设置与清除**：`setBanner` 对同一 id 整条替换。只有设置它的插件能用 `clearBanner(id)` 清除；浏览器、其他插件和 pi-pane 自己都不能清除 persistent 横幅，唯一的例外见下文“来源插件已从配置中移除”。插件可以用 `ctx.listBanners()` 取得自己当前的横幅（含上次运行留下的 persistent 横幅），在 `activate` 时按自己的状态逐条确认、更新或清除。
- **persistent 横幅**：pi-pane 写入数据目录的 `banners.json`（写临时文件后原子替换），pi-pane 重启后恢复。来源插件没有加载、初始化失败、被停用或卸载时，persistent 横幅保留，`sourceUnavailable` 为 true，浏览器在横幅上附加提示“来源插件不可用，无法确认当前状态”，动作按钮不可用。来源插件重新启用后 `sourceUnavailable` 变回 false，横幅是否保留由插件决定。
- **来源插件已从配置中移除**：`config.json` 的 `plugins` 里已没有该插件时，它留下的 persistent 横幅不会再有人清除。设置页列出这些横幅，已登录的浏览器可以手动移除：需要二次确认，服务端把移除的横幅内容、时间和发起的标签页写入日志。插件仍在配置里、只是停用或加载失败时，不允许手动移除。
- **非 persistent 横幅**：只在服务端内存里。pi-pane 重启后消失；来源插件停用或卸载时随之移除。
- **动作**：`actions` 复用“动作”一节的 `ActionSpec` 和 `actions.invoke`，点击流程、确认、表单和幂等规则相同。动作执行成功不会自动移除横幅，由插件在状态恢复后自己调用 `clearBanner`。
- `title` 按纯文本、`body` 按 [architecture.md](architecture.md#渲染与资源安全) 的规则渲染。
- `banners.json` 同样可以被同一系统用户下的程序删除，见 [architecture.md](architecture.md#剩余风险)。

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
- 对话框的标题和内容按纯文本显示，不渲染 Markdown 或 HTML。

## 版本

pane 协议的版本由 pi-pane 定义和维护：

- pi-pane 声明自己支持的范围（当前 `[1, 1]`），插件在 `package.json` 和 `PanePlugin.paneProtocol` 里声明自己的范围；取交集中的最大值作为协商结果，通过 `ctx.paneProtocol` 告诉插件。没有交集时拒绝加载。
- 新增可选字段、新增 `capabilities` 值、新增 `PanelContent.type`、新增会话事件类型不升版本；pi-pane 和插件都忽略不认识的字段、能力值和事件。删除字段或改变字段语义才升版本，pi-pane 至少同时支持当前和上一个版本。
- 改协议先改本文，再改 `@pi-pane/plugin-api`，并在发布说明里写明。

## 与 pi-agora 的集成

pi-agora 提供 `@pi-agora/pane-plugin`，实现上述接口：子代理、会议、参会者、书记、board 在树中的位置，会议进度（`steps` 面板），提问、会议决策、待批准设备和命令行待确认操作（持久表单，进入 pi-pane 的待处理区），返工、停止、答复、召集会议等动作，用户级操作的 `userPresence` 确认，以及 agora 后台服务不在线时的存档读取。agora 的数据如何映射到本协议、agora 后台服务的 HTTP API，见 pi-agora 仓库的 `docs/integration.md`。pi-pane 不依赖 pi-agora。
