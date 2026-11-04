# 总体架构

> 状态：设计草案。接口和默认值是草案，P0 验证后冻结。

pi-pane 是 pi 的轻量 Web 界面。服务端为每个打开的主会话拉起一个 `pi --mode rpc` 子进程，把聊天流转发给浏览器；子代理、会议等功能由插件通过通用接口显示，pi-pane 本身不实现这些业务。

插件接口见 [plugin-api.md](plugin-api.md)，图片占位符见 [image-placeholders.md](image-placeholders.md)。与 pi-agora 的集成协议以 pi-agora 仓库的 `docs/integration.md` 为准。

## 设计约束

- **基座是 pi**（`@earendil-works/pi-coding-agent` 1.4.0），不重写 Agent 运行时、Provider、压缩。
- **每个主会话一个 `pi --mode rpc` 子进程**。一个会话的工具卡死或崩溃只影响它自己。只实现这一种会话驱动，保留 `SessionDriver` 接口。
- **界面只是界面**：pi-pane 不认识“子代理”“会议”，只提供会话树、面板、动作、表单、通知这些通用接口。
- **轻量**：前端打包目标 300 KiB（gzip，不含图片资源）以内；不做终端、Git、文件编辑器等功能（见“明确不做”）。
- **只在本机使用**：只监听 loopback。

## 组件

```text
浏览器（web）
   │ HTTP 命令 + 一条 WebSocket
   ▼
pi-pane 服务端（server）
 ├─ 鉴权、静态文件、WebSocket 事件分发
 ├─ 会话托管：SessionDriver（每个主会话一个 pi RPC 子进程）
 │    └─ 子进程里加载用户自己的 pi 扩展 + pane-bridge 扩展
 ├─ 扩展 UI 适配：pi 原生 select/confirm/input/editor 等 → 浏览器
 ├─ 附件存储（图片）
 └─ 插件宿主：加载可信的服务端插件（如 pi-agora 的 pane 插件）
```

| 包（草案） | 职责 |
| --- | --- |
| `packages/server` | 服务端：会话托管、RPC 驱动、鉴权、WebSocket、附件、插件宿主 |
| `packages/web` | 前端：会话列表与树、聊天视图、输入框、对话框、面板 |
| `packages/bridge-extension` | 加载进每个主会话的 pi 扩展：图片顺序还原、多题表单通道 |
| `packages/plugin-api` | 插件接口和 pane 协议 v1 的 TypeScript 类型（按 pi-agora `docs/integration.md` 定义） |

前端技术栈（草案）：Vite + Preact。选择理由是打包体积小；P0 期间可以换，但不改变接口。

## 会话托管

### 拉起

服务端用 `process.execPath` 直接运行 pi 的 JS 入口（`package.json` 的 `bin.pi` 指向 `dist/bundle/cli.js`），不经 shell：

```text
node <pi>/dist/bundle/cli.js --mode rpc
  --session <sessionFile>          # 打开已有会话
  （或不带 --session，在指定 cwd 下新建）
  -e <pane-bridge 扩展路径>
```

- **不加 `-ne`**：主会话加载用户自己配置的 pi 扩展、技能、MCP，和在终端里运行 pi 一样。pi-agora 的扩展也是这样进入主会话的。
- `cwd` 作为 spawn 参数传入；`windowsHide: true`。
- 拉起后调用 RPC `get_state` 取 `sessionId`、`sessionFile`、模型和 thinking（依据：pi `docs/rpc-commands.md`）。

### 会话列表

会话列表直接读 pi 的会话存储（默认 `~/.pi/agent/sessions/`，按工作目录分组，依据：pi `docs/sessions.md`），用 pi 导出的 `SessionManager.list()` / `listAll()` 读取（依据：`dist/core/session-manager.d.ts`）。pi-pane 不复制会话数据，终端里创建的会话也能在列表里打开。

按项目（工作目录）分组显示；每个会话显示名称、最后修改时间、消息数。

### 单一驱动

- 同一个会话文件在 pi-pane 内同时只有一个子进程。多个浏览器标签页打开同一会话，共享同一个子进程和事件流。
- pi-pane 无法知道终端里是否有 pi 正在使用同一个会话文件。打开会话前检查文件最近 60 秒内是否被修改，是则提示“该会话可能正在别处运行”，由用户确认后再打开。

### 关闭与回收

- 用户在界面上关闭会话：等当前运行 settled（或用户选择中止）后停止子进程。会话文件不受影响。
- 空闲回收：会话 settled、没有待回应的扩展 UI 对话框、没有浏览器连接，持续 30 分钟后停止子进程（`mainIdleReclaimMs`，默认 1800000）。再次打开时重新拉起。
- 停止顺序：RPC `abort`（运行中时）→ 关闭 stdin → 等待 5 秒 → 终止进程树。Windows 上的进程树终止方案与 pi-agora 相同，见 pi-agora `docs/architecture.md` 的“Windows 注意事项”。

### 会话驱动接口

```ts
// 草案，P0 后冻结
interface SessionDriver {
  start(spec: { cwd: string; sessionFile?: string; extraExtensions: string[]; env?: Record<string, string> }): Promise<DriverHandle>;
}

interface DriverHandle {
  readonly pid: number;
  send(cmd: RpcCommand): Promise<RpcResponse>;
  onEvent(listener: (ev: RpcEvent) => void): () => void;   // 会话事件 + extension_ui_request
  respondUi(res: ExtensionUiResponse): void;
  stop(opts: { graceMs: number }): Promise<ExitInfo>;
}
```

不直接用 pi 的 `RpcClient`：它的公开声明里没有回应扩展 UI 请求的接口（依据：`dist/modes/rpc/rpc-client.d.ts`）。

## 浏览器与服务端的数据流

### 通道

- **命令**：HTTP `POST /api/...`，每个命令带 `requestId`（同时作为幂等键）。如发送消息、steer、中止、切换模型、回应对话框、调用插件动作、上传图片。
- **事件**：一条 WebSocket `/ws`。浏览器订阅关心的会话和插件来源，服务端推送事件。

```ts
// 服务端 → 浏览器，草案
type ServerMessage =
  | { type: "session"; ref: SessionRef; seq: number; event: object }      // pi 会话事件或 pane_status
  | { type: "resync"; ref: SessionRef }                                    // 需要重新取快照
  | { type: "tree"; source: string; change: TreeChange }
  | { type: "panel"; panelId: string; revision: number }
  | { type: "ui_request"; ref: SessionRef; request: ExtensionUiRequest }   // pi 原生扩展 UI
  | { type: "form"; form: FormSpec }
  | { type: "notification"; notification: PaneNotification };
```

`SessionRef`、`TreeChange`、`FormSpec`、`PaneNotification` 等类型由 pane 协议 v1 定义（pi-agora `docs/integration.md`）。主会话的 `SessionRef` 是 `{ source: "pane", id: <piSessionId> }`。

### 事件序号与重连

- 服务端给每个会话的事件分配递增 `seq`，并在内存中保留最近 2000 个事件。
- 浏览器打开会话：`GET /api/sessions/:id/snapshot` 取快照（RPC `get_messages` 的最终消息 + 服务端缓存的进行中消息 + 当前 `seq`），再通过 WebSocket 订阅 `afterSeq`。
- 断线重连：带上最后收到的 `seq` 重新订阅；序号已超出缓冲区时服务端发 `resync`，浏览器重新取快照。
- `message_update` 只带增量（依据：pi `docs/json.md`），浏览器按 `contentIndex` 拼接，收到 `message_end` 后用完整消息替换。

### 慢客户端

- 服务端读 RPC stdout 不受浏览器影响，浏览器慢不会阻塞 pi。
- 某个 WebSocket 的发送缓冲超过 1 MiB：同一消息的连续文本增量合并后再发；超过 8 MiB：丢弃该连接的待发增量，发送 `resync`。

## 鉴权

- 只监听 `127.0.0.1`（端口默认 4319，可配置）。
- 启动时生成随机访问令牌，写入 `~/.pi/pane/secret/access-token`（仅当前用户可读，Windows 用 ACL），并在终端打印带令牌的地址 `http://127.0.0.1:4319/#token=...`。
- 浏览器首次用令牌换取会话 Cookie（`HttpOnly`、`SameSite=Strict`），随后从地址栏移除令牌。
- 每个 HTTP 请求和 WebSocket 握手都校验：Cookie 有效；`Host` 头是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS 重绑定）；`Origin` 与之匹配。`POST` 还要求自定义请求头 `X-Pane-Request: 1`。
- 浏览器不持有 pi-agora daemon 的任何凭证，插件在服务端代为访问。
- 不防同一操作系统用户下的恶意程序。

## 插件宿主

- 只加载可信插件：配置文件 `~/.pi/pane/config.json` 的 `plugins` 列表中显式列出的包或路径。
- 插件运行在服务端进程内，和 pi-pane 有相同的系统权限。
- 插件只能提供声明式 UI（树节点、面板内容、动作、表单、通知），不能向浏览器注入脚本。
- 插件抛出异常或超时（单次调用 10 秒）不影响主会话，对应面板显示错误。

详见 [plugin-api.md](plugin-api.md)。

## 数据目录

默认 `~/.pi/pane/`，可用环境变量 `PI_PANE_HOME` 覆盖。

```text
~/.pi/pane/
  config.json        # 端口、插件列表、回收时间等
  secret/            # 访问令牌、bridge 密钥（仅当前用户可读）
  assets/            # 图片附件，见 image-placeholders.md
  state.json         # 界面状态：打开的会话、侧栏展开状态
```

pi-pane 不保存对话内容，对话只在 pi 的会话文件里。

## 核心功能范围

MVP 包含：

1. 按项目列出会话，新建、打开、关闭会话。
2. 聊天流：Markdown 渲染、思考内容折叠、工具调用卡片（参数和结果）、`edit` 的差异显示。
3. 输入框：发送、steer（运行中追加）、follow-up（排队）、中止；图片占位符。
4. 模型与 thinking 选择（RPC `get_available_models`、`set_model`、`set_thinking_level`）。
5. 上下文用量和费用显示（RPC `get_session_stats`）。
6. pi 原生扩展 UI：select、confirm、input、editor、notify、setStatus、setWidget（文本）、setTitle、set_editor_text。
7. 插件接口：会话树、面板、动作、表单、通知；子会话的实时流和存档查看。

## 明确不做

- 终端、Git 面板、文件编辑器、canvas、设备中心、审批规则引擎、定时任务。
- 子代理、会议等业务逻辑（由插件提供）。
- 第三方插件的前端代码、插件市场。
- 公网访问、多用户。
- 同一会话的多端协同编辑（多个标签页共享同一会话，但不做冲突合并）。
- pi TUI 的自定义组件（`ctx.ui.custom()` 在 RPC 模式下不可用，依据：pi `docs/rpc-extension-ui.md`）。

## Windows 注意事项

- 拉起 pi 不经 shell，`cwd` 用 spawn 参数，`windowsHide: true`。
- 停止会话后不能留下 `bash` 工具启动的进程（与 pi-agora 同一验收项）。
- 路径显示和比较统一大小写与分隔符。
- `secret/` 目录用 `icacls` 限制为当前用户（execFile 调用，不经 shell）。
