# pi-pane

pi-pane 是 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码智能体的轻量 Web 界面。它在浏览器里显示和操作 pi 会话；子代理、会议等功能由插件提供，pi-pane 只提供通用的显示接口。

> **当前状态：设计阶段，还没有代码。** 本仓库目前只有设计文档，接口和默认值都是草案，P0 验证后冻结。

## 功能

- **托管主会话**：每个打开的会话对应一个 `pi --mode rpc` 子进程，加载你自己的 pi 扩展、技能和配置，和在终端里运行 pi 一样。
- **聊天**：Markdown、思考内容折叠、工具调用卡片、`edit` 差异显示；发送、运行中追加（steer）、排队（follow-up）、中止；切换模型和 thinking；查看上下文用量和费用。
- **图片占位符**：图片可以插在文字中的任意位置，如 `看看这张图[Image #1]，再对比[Image #2]`，模型按这个顺序收到图文。
- **pi 扩展对话框**：扩展调用的选择、确认、输入、编辑对话框和通知在浏览器里显示。
- **插件接口**：插件可以向侧栏会话树添加节点（如主对话下挂的子代理、会议），提供面板、动作按钮、多题表单和通知。子会话可以点开看实时流，结束后看完整存档。

不包含终端、Git、文件编辑器、canvas、设备中心、审批规则引擎和定时任务。

## 和 pi-agora 的关系

| 项目 | 职责 |
| --- | --- |
| pi-pane（本仓库） | 轻量 Web 界面：托管主会话、聊天流、图片占位符、通用插件接口 |
| pi-agora | 协作引擎：子代理、共享桌面（board）、会议、提问与答复、全量对话存档；可以不装 pi-pane 单独使用 |

pi-pane 不认识“子代理”“会议”，也不依赖 pi-agora。pi-agora 提供一个 pi-pane 插件，通过通用接口把子会话树、board、待处理事项等显示出来。

- 插件接口（pane 协议）以本仓库的 [docs/plugin-api.md](docs/plugin-api.md) 为准，所有插件共用。
- agora 后台服务的 HTTP API、agora 数据如何映射到插件接口，以 pi-agora 仓库的 `docs/integration.md` 为准。

## 组成

```text
packages/
  server/             服务端：会话托管、鉴权、WebSocket、附件、插件宿主
  web/                前端
  bridge-extension/   加载进每个主会话的 pi 扩展：图片顺序还原、多题表单通道
  plugin-api/         插件接口和 pane 协议类型（@pi-pane/plugin-api）
```

运行环境（计划）：Node.js 24 及以上，pi 1.4.0；只监听本机地址；首先支持 Windows，其他平台随后验证。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 会话托管、浏览器与服务端的数据流和重连、鉴权、插件宿主、核心功能范围、明确不做的功能 |
| [docs/plugin-api.md](docs/plugin-api.md) | 插件接口与 pane 协议（权威定义）：会话树、会话视图、面板、动作、表单、通知的类型和规则、版本协商，以及 pi 原生扩展 UI 的适配 |
| [docs/image-placeholders.md](docs/image-placeholders.md) | 图片占位符：输入框行为、assetId 与存储、保持图文顺序的做法、P0 验证清单 |
| [docs/roadmap.md](docs/roadmap.md) | P0、MVP、工程量、明确不做、主要风险 |
| pi-agora 仓库 `docs/integration.md` | agora 后台服务的 HTTP API 和 agora 到本插件接口的映射 |
