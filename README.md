# pi-pane

pi-pane 是 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码智能体的轻量 Web 界面。它在浏览器里显示和操作 pi 会话；子代理、会议等功能由插件提供，pi-pane 只提供通用的显示接口。

> **当前状态：M1 核心与 M3 插件服务端。** 三个 workspace 包提供会话托管、pane 协议类型、pane-bridge 和可信插件宿主，通过 HTTP 与 WebSocket 接口使用。Web 界面、插件界面及 agora 联调不在本分支的验收范围。开发与验收说明见 [docs/development.md](docs/development.md)。

## 为什么要做

pi 在终端里工作得很好，但有几件事终端做不好：

- **图文混排**：终端里只能把图片附在消息末尾，无法写“看这张图[Image #1]，再对比[Image #2]”并让模型按这个顺序收到图文。
- **多个会话一起看**：主代理派出子代理、召开会议后，同时有多条会话在运行。终端一次只能看一条，pi-pane 用侧栏的会话树把它们放在一起，点开就能看实时输出或存档。
- **需要用户回应的事不被淹没**：插件转给用户的事项（如子代理的提问、会议的决策请求）在侧栏的“待处理”区统一列出，关掉浏览器再打开仍在。pi 扩展弹出的选择、确认框不进“待处理”区，在所属会话里弹出；没有浏览器连接时保留，下次打开该会话时再弹出。
- **区分用户和 Agent**：子代理和用户以同一个系统用户运行，能读到磁盘上的任何凭证。浏览器里的设备密钥让“这是用户本人点的确认”可以被验证，供 pi-agora 这类插件把用户级操作和 Agent 的操作分开。

pi-pane 不替代终端：会话仍然是 pi 自己的会话文件，在终端和 pi-pane 之间可以来回打开。

## 功能范围

以下为完整 MVP 的目标范围。本分支提供主会话与插件的服务端能力，浏览器界面另行交付。

- **托管主会话**：每个打开的会话对应一个 `pi --mode rpc` 子进程，加载你自己的 pi 扩展、技能和配置，和在终端里运行 pi 一样。没在运行的会话可以只读查看，第一次发送时再启动。
- **聊天**：Markdown、思考内容折叠、工具调用卡片、`edit` 差异显示、压缩分隔标记；发送、运行中追加（steer）、排队（follow-up）、停止（排队中的消息退回输入框）；切换模型和 thinking；查看上下文用量和费用。
- **斜杠命令**：`/compact`、`/model`、`/new`、`/name`、`/fork`、`/export` 等常用的内置命令，以及扩展命令、技能和提示模板的补全。
- **图片占位符**：图片可以插在文字中的任意位置，如 `看看这张图[Image #1]，再对比[Image #2]`，模型按这个顺序收到图文。
- **pi 扩展对话框**：扩展调用的选择、确认、输入、编辑对话框和通知在浏览器里显示；项目信任询问也在浏览器里确认。
- **插件接口**：插件可以向侧栏会话树添加节点（如主对话下挂的子代理、会议），提供面板、动作按钮、多题表单、通知、常驻横幅和用户在场确认。子会话可以点开看实时流，结束后看完整存档。

不包含终端、Git、文件编辑器、canvas、设备中心、审批规则引擎和定时任务。

## 运行环境与安全

- Node.js 24 及以上；pi 1.5.x（`>=1.5.0 <1.6.0`），依次从配置项 `piPath`、pi 官方安装脚本的安装目录、全局 npm 目录查找。
- Windows、macOS、Linux 同时支持。
- 浏览器只支持 Chrome；其他浏览器（含 Edge 等 Chromium 内核）不测、不承诺。
- 只监听 `127.0.0.1`，浏览器只能用 `http://127.0.0.1:<端口>`（默认 4319）访问。
- 启动时终端里显示一次性配对码；浏览器用它登录，凭证只留在浏览器标签页里，不写入磁盘，也不用 Cookie。
- 端口改变、换浏览器或清除浏览器数据后，浏览器的设备密钥会变，插件（如 pi-agora）会要求重新批准这台设备。

- 这些措施只拦低成本的冒充和误操作。Agent 与你是同一个系统用户、在同一个桌面会话里，可以借系统自动化向终端输入、替你在浏览器里点确认。需要真正隔离时，要让 Agent 以另一个系统用户、在沙箱或虚拟机里运行，这不在本项目计划内。

细节见 [docs/architecture.md](docs/architecture.md#鉴权)，剩余风险见 [docs/architecture.md](docs/architecture.md#剩余风险)。

## 和 pi-agora 的关系

| 项目 | 职责 |
| --- | --- |
| pi-pane（本仓库） | 轻量 Web 界面：托管主会话、聊天流、图片占位符、通用插件接口 |
| pi-agora | 协作引擎：子代理、共享桌面（board）、会议、提问与答复、全量对话存档；可以不装 pi-pane 单独使用 |

pi-pane 不认识“子代理”“会议”，也不依赖 pi-agora。pi-agora 提供一个 pi-pane 插件，通过通用接口把子会话树、board、会议进度、待处理事项等显示出来。两者共用平台相关的包 [pi-hostkit](https://github.com/PosvdM/pi-hostkit)（进程管理、锁、路径规范化等）。它是独立仓库，权威设计见其 [docs/design.md](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md)。

- 插件接口（pane 协议）以本仓库的 [docs/plugin-api.md](docs/plugin-api.md) 为准，所有插件共用。
- agora 后台服务的 HTTP API、agora 数据如何映射到插件接口，以 pi-agora 仓库的 `docs/integration.md` 为准。

## 组成

```text
packages/
  server/             服务端：会话托管、鉴权、WebSocket、附件、插件宿主
  web/                前端
  bridge-extension/   加载进每个主会话的 pi 扩展：图片顺序还原、多题表单通道、会话切换回报、项目信任决定
  plugin-api/         插件接口和 pane 协议类型（@pi-pane/plugin-api）
```

## 开发运行

需要 Node.js 24 及以上、npm、pi 1.5.x，以及构建 pi-hostkit 原生模块所需的 Python 和 C/C++ 工具链。

```sh
npm ci
npm test
npm start
```

`npm start` 提供服务端接口，默认监听 `127.0.0.1:4319`，终端显示一次性配对地址。当前没有可操作的首页。配置文件为 `~/.pi/pane/config.json`，可设置 `piPath`、`port`、`idleReclaimMs` 和 `plugins`；`PI_PANE_HOME` 可覆盖数据目录。`plugins` 只填写可信服务端插件的 npm 包名或本地目录，因为插件与服务端有相同的系统权限，不是沙箱。加载约定见 [插件接口](docs/plugin-api.md#插件的加载)，接口与测试入口见 [开发文档](docs/development.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | pi 版本与定位、会话托管（写锁、会话切换、项目信任、停止）、数据流与重连、斜杠命令、鉴权、渲染安全、剩余风险、插件宿主、pane-bridge、明确不做的功能 |
| [docs/plugin-api.md](docs/plugin-api.md) | 插件接口与 pane 协议（权威定义）：会话树、会话视图、面板、动作、表单、通知、横幅、用户在场确认的类型和规则、版本协商，以及 pi 原生扩展 UI 的适配 |
| [docs/image-placeholders.md](docs/image-placeholders.md) | 图片占位符：输入框行为、上传与存储、保持图文顺序的做法、P0 验证清单 |
| [docs/roadmap.md](docs/roadmap.md) | P0、MVP 切分、工程量、明确不做、主要风险 |
| pi-agora 仓库 `docs/integration.md` | agora 后台服务的 HTTP API 和 agora 到本插件接口的映射 |
| [pi-hostkit 仓库 `docs/design.md`](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md) | 共享包 pi-hostkit 的权威设计：定位 pi、RPC 传输、进程树终止、锁、目录权限、路径规范化 |
