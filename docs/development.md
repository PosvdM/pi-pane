# 开发与验收

## 环境与构建

需要 Node.js 24 及以上、npm、pi 1.5.x 或 1.6.x 和原生模块编译工具链。Windows 使用带 C++ 工作负载的 Visual Studio Build Tools；macOS 使用 Xcode Command Line Tools；Linux 使用 Python 3、gcc 和 make。

`npm ci` 安装固定 git 提交的 pi-hostkit，依赖的 prepare 脚本构建 TypeScript 和原生模块。本仓库固定到 `ebb76757038e622f7d12b4da0cf2091f8a3c89e9`，其支持的 pi 版本为 `>=1.5.0 <1.7.0`；路径并发创建复核、Linux 进程状态有界重读及 Windows Job 退出可见性由 hostkit 处理。没有 npm 发布包，也不要求本地链接其他仓库。

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 按 TypeScript project references 构建服务端相关包，再构建 Web 界面并检查 gzip 体积 |
| `npm run build --workspace @pi-pane/web` | 检查前端 TypeScript，使用 Vite 构建 `packages/web/dist`，并检查 gzip 体积 |
| `node packages/web/scripts/check-bundle.mjs` | 对已有前端产物执行 gzip 体积检查；需先构建 |
| `npm test` | 先构建，再用 node --test 顺序运行测试文件 |
| `node --test test/<文件>.test.mjs` | 运行单个测试文件；修改源码后先构建 |
| `npm start` | 启动 API 服务端、插件宿主和前端 |

前端使用 Vite 和 Preact。体积检查累计 `packages/web/dist` 中全部 HTML、JavaScript 和 CSS 文件以 gzip level 9 压缩后的字节数，总和不得超过 300 KiB。`npm test` 的 `pretest` 包含完整构建及体积检查；直接运行 `node --test` 不执行构建。

`PI_PACKAGE` 可在测试时指定 pi 包目录。未设置时用 hostkit 的定位规则，先查官方安装目录，再查全局 npm。测试使用真实 pi 和本地假 provider，不访问模型服务；找到的 pi 不在支持范围内时测试失败。设置 `HOSTKIT_TEST_PI_VERSION` 时，测试还要求找到的 pi 正好是该版本，CI 用它确认测的是矩阵指定的版本；该变量设为空字符串时测试直接失败。测试的 HOME、USERPROFILE、agent 目录、锁目录和会话文件位于临时现场；Chrome 使用独立的临时配置目录。服务端拒绝配置中的非法端口与 Fetch 禁止端口；测试使用 `port: 0` 自动分配端口，遇到禁止端口时关闭监听后重试，最多尝试 20 次，端口判断、重试及配置拒绝后的实例锁可用性由 `test/ports.test.mjs` 验证。设置 `KEEP_FIXTURES=1` 可保留现场。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `packages/plugin-api/src/index.ts` | 按 plugin-api.md 导出 pane v1 类型和协议版本协商；不实现插件宿主 |
| `packages/server/src/auth.ts` | 配对码、内存凭证、一次性 WebSocket ticket 和规范源校验 |
| `packages/server/src/server.ts` | 规范源 HTTP、WebSocket 首帧鉴权、订阅与背压、multipart 图片上传 |
| `packages/server/src/sessions.ts` | 会话登记、控制队列、增量取条目、切换路由、只读文件监视和回收 |
| `packages/server/src/draft-outbox.ts` | 停止、关闭或关停时清出、尚未领取的排队草稿的落盘存储、读取、原子领取和过期清理 |
| `packages/server/src/web-api.ts`、`web-adapter.ts`、`exports.ts` | 浏览器协议类型、pi 数据转换与 HTML 导出下载存储 |
| `packages/server/src/driver.ts` | hostkit 写锁、启动门闩、RPC、就绪超时、进程停止和运行身份记录 |
| `packages/server/src/writer-recovery.ts`、`stop-report.ts` | 首次拉起与目标切换的共同恢复检查、不完整报告隔离和停止报告判定 |
| `packages/server/src/hostkit-cleanup.ts` | hostkit 拒绝中的清理事实识别及同步、异步调用观察 |
| `packages/server/src/inflight.ts` | 实例共用的关闭门禁、在途操作与资源 owner 登记、限时排空、登记来源诊断、超时失败闩及终止释放检查 |
| `packages/server/src/pi-rpc.ts` | pi 主会话的原生 RPC 信封；不属于通用插件契约 |
| `packages/server/src/pi-commands.ts` | pi 终端专用命令名单与消息开头识别；由会话控制在启动前检查 |
| `packages/server/src/model.ts` | 活动分支、inFlight、同步快照切点、事件缓冲和游标 |
| `packages/server/src/store.ts` | 只读 v1/v2/v3 解析、pi 会话目录和列表、目录占位消歧、临时副本 fork |
| `packages/server/src/session-title.ts` | 服务端统一名称归一化、首条文本提取和 Unicode 标题回退，供目录/只读/托管及 Web 适配复用 |
| `packages/server/src/session-catalog.ts` | 会话目录：存储目录的一行叠加登记会话的实时状态，投影为前端会话列表项、`MainSessionInfo` 和主会话树行 |
| `packages/server/src/assets.ts` | 上传资源、草稿编码、历史图片引用、缓存与清理 |
| `packages/server/src/bridge.ts` | 独立的 Agent 级回连凭证和实例 fencing |
| `packages/server/src/trust.ts` | 启动前及进程内切换时的信任预判与询问 |
| `packages/server/src/plugins/` | 插件加载与隔离、按需主会话树、上下文资源、事务幂等、持久表单、用户在场确认和横幅 |
| `packages/bridge-extension/src/` | 会话替换和写锁回报、信任决定、就绪握手、图片顺序还原 |
| `packages/web/` | Vite 与 Preact 浏览器界面、会话事件投影、草稿和 IndexedDB 设备密钥管理 |

插件宿主通过通用 HTTP 和 WebSocket 提供能力，浏览器中的插件界面见[前端结构](#前端结构)。多题表单通道保留事件名称和 BridgeFormOutcome 类型，未启用时返回协议已有的 aborted。

## 前端结构

下表路径均相对于 `packages/web/src/`。

| 路径 | 职责 |
| --- | --- |
| `app.tsx`、`main.tsx`、`style.css` | 应用入口、配对页与主界面装配、全局样式 |
| `lib/api.ts`、`lib/auth.ts` | HTTP 调用与错误、配对、标签页凭证共享和失效处理 |
| `lib/ws.ts` | WebSocket 首帧鉴权、断线重连，会话订阅（按 `(source, id)`）与树订阅的游标续订 |
| `lib/session.ts`、`lib/session-model.ts` | 会话导航、快照、控制命令与状态查询；按游标投影会话事件 |
| `lib/tree-state.ts`、`lib/tree.ts` | 单个来源的树状态（快照、订阅、分页按修订号与 tombstone 合并）；侧栏使用的各来源快照、订阅、分页加载和打开节点的固定 |
| `lib/plugins.ts`、`lib/navigate.ts` | 插件列表、显示名称与静态目录（动作、面板、自定义消息渲染器）；打开树节点 |
| `lib/plugin-ui.ts`、`lib/plugin-session.ts` | 持久表单（含重连对齐）、横幅、通知、在场确认与设备登记、面板修订号，动作与表单的提交和查询；插件会话按能力取快照和订阅、重试、发送与停止 |
| `lib/operation.ts` | 结果需要确定的一次操作（动作调用、向插件会话发消息）：首次响应和每次“查询结果”的返回交给同一个对象结算，记住提交时移出输入框的原文是否已放回，最多放回一次；不依赖 DOM，由 `web-operation` 直接测试 |
| `lib/plugin-state.ts` | 插件界面中不依赖 DOM 的规则：通知保留、横幅折叠、标题栏动作上限、侧栏宽度范围、输入框文字放回，由 `web-logic` 直接测试 |
| `lib/draft.ts`、`lib/images.ts`、`lib/blobs.ts` | 图文草稿运算、图片缩放与上传、鉴权取图及 blob URL 缓存 |
| `lib/tab.ts` | 标签页标识：`sessionStorage` 中的 tabId，页面存活期间持有 `pi-pane.tab.<tabId>`，复制标签页时换新；没有 Web Locks 时每次加载换新 |
| `lib/restored.ts` | 按标签页分键的输入框草稿（写入失败时暂存内存）和已关闭标签页草稿的收养（含等待其他标签页关闭）、在途提交与页面关闭后的取回、归属不明提示；停止、关闭清出或没有送达的草稿按会话交给输入框，未挂载时存入待放回记录 |
| `lib/saved-drafts.ts` | 服务端保存的清出草稿：读取各会话未领取的记录、领取（120 秒总期限，响应丢失时用同一 `requestId` 重试；结果未知的领取记在 `sessionStorage` 中，刷新后仍可重试，收到确定的错误时换新的 `requestId`）、按记录的领取中状态、放回和放弃按发起时的会话处理，以及本页等待停止结果期间隐藏对应记录 |
| `lib/markdown.ts` | 不可信 Markdown 的链接过滤、远程图片替代和代码高亮 |
| `lib/device-key.ts`、`lib/jcs.ts` | IndexedDB 设备密钥、签名与 RFC 8785 规范 JSON |
| `lib/events.ts`、`lib/ui-state.ts` | 扩展 UI 与信任询问事件、对话框和提示状态 |
| `lib/settings.ts`、`lib/actions.ts` | 本地界面偏好、导出下载和侧栏开关 |
| `lib/store.ts`、`lib/types.ts` | 可订阅状态容器、前端协议类型出口 |
| `components/Sidebar.tsx`、`components/Chat.tsx` | 待处理区、主会话与插件节点合并的会话树、菜单与侧栏面板；主会话的聊天记录与会话状态布局 |
| `components/PluginSession.tsx`、`components/Panels.tsx`、`components/PluginDialogs.tsx` | 插件会话视图；面板内容渲染与节点面板（插件节点和主会话共用，“详情”开关与窄屏抽屉）；表单、在场确认、横幅、通知 |
| `components/Composer.tsx`、`components/Message.tsx` | 输入框、图片占位符与命令补全；消息、思考和工具卡片渲染 |
| `components/SavedDrafts.tsx` | 输入框上方的待取回条：列出该会话未领取的清出草稿记录，“放回输入框”或“放弃”；本页结果未知的领取标“领取结果未知”，“重试” |
| `components/Dialogs.tsx`、`components/Overlays.tsx` | 扩展对话框、信任询问和确认；设置、模型、思考级别及会话操作弹层 |

前端只以 `import type` 引用 `web-api.ts` 与 `@pi-pane/plugin-api` 的类型，`lib/types.ts` 用 `export type` 汇总，不把服务端实现打入浏览器包，也不解析 pi 原始 RPC 信封或会话文件。`session-model.ts` 按 [plugin-api.md 的“事件流”](plugin-api.md#事件流)游标规则投影会话事件。

### 运行时约束

修改前端代码时须保持以下行为：

- **快照与续订**：先取得快照，再从其游标订阅；断线按最后游标续订，收到 `resync`、游标跳号或 epoch 不符时重新取快照并重新订阅，避免增量重复或缺失。
- **导航代次**：打开、重取快照及其事件屏障须绑定会话和导航代次；只有最后一次导航能提交视图、错误、订阅和最近会话记录，旧请求不能覆盖新选择或屏蔽新会话事件。打开插件节点同样是一次导航：主会话的导航代次随之失效并取消订阅，`/new` 等迟到的切换结果和替换事件不再把视图拉回主会话。插件会话的历史页请求记下发起时的会话模型，其间重取过快照时丢弃。
- **控制重试**：`pending` 每秒用同一请求体查询结果；网络错误也复用原 `requestId` 和完整请求体，网络重试窗口为发起控制后的 120 秒。超出窗口提示用户先核对会话再决定是否重发，不能把响应丢失直接当成未执行。停止和关闭清出的草稿在返回结果之前已保存为服务端记录，结果没有交到页面时记录出现在待取回条中，浏览器不另存请求体续取。
- **并发冲突**：收到 409 `revisionChanged` 后重取快照，提交的内容放回输入框，由用户重新确认送达方式或重新执行命令；不能自动用新 revision 重发，以免把旧意图应用到已变化的状态。
- **扩展对话框**：服务端保存权威待答记录，每次订阅前清空本地对话框副本并等待服务端重发，避免显示离线期间已被其他标签页回答的问题。HTTP 回答失败时保留问题，相同答案重试复用请求体和 `requestId`。
- **草稿保存**：编辑时立即捕获节点，延迟 300 毫秒写入按会话和标签页区分的 `localStorage` 键，每个键只由一个标签页写入，页面隐藏和 `pagehide` 时立即写入；写入失败时暂存在页面内存并提示（见 [architecture.md 的“取回草稿的交付”](architecture.md#停止与控制队列)）。切换会话或卸载时同步提交捕获内容并取消计时器，不能把缺失的 DOM ref 当成空草稿。挂载或切换会话时读出的草稿不写回；输入框挂载、页面回到前台和等到其他标签页关闭时收养已关闭标签页的草稿。输入框的 HTML 由 `Composer.tsx` 的 `editorHtml` 生成，与 `readNodes` 互逆：以换行结尾的内容另加一个占位 `<br>`，末尾换行、连续换行和图片前后的换行写入后读回不变。提交消息或命令时立即清空并同步写入，内容存为在途提交，没有送达时放回（见 [architecture.md 的“提交即清空”](architecture.md#停止与控制队列)）。恢复图片草稿先显示内容，异步 touch 仅标记仍在 DOM 中的过期图片，不覆盖等待期间的编辑。
- **图片编辑**：图片节点通过 `execCommand` 插入、删除和移动，保留 Chrome 原生撤销与重做；插入时暂去节点 class，完成后恢复，避免 Chrome 复制计算样式并生成违反 CSP 的内联样式。
- **设备密钥**：登录后的应用初始化读取或生成不可导出的私钥，不依赖打开设置页；生成和重置通过同源 Web Locks 串行化，避免多个标签页各自写入不同密钥。签名格式见 [plugin-api.md 的“签名格式”](plugin-api.md#签名格式)，浏览器在每次 WebSocket 建立和重置设备密钥后向服务端登记设备，`userPresence` 确认用它签名。

## 浏览器测试

`test/fixtures/browser.mjs` 提供以下共用入口：

- `requireChrome(t)` 使用 `CHROME_PATH`、`CHROME_BIN` 和三平台常见安装路径定位 Chrome。本机未安装时跳过测试；设置 `PANE_TEST_REQUIRE_CHROME=1` 时缺少 Chrome 会导致失败。
- `startWebServer(fixture, extra)` 使用 `packages/web/dist` 作为静态资源根目录。缺少产物时提示先运行 `npm run build`。
- `launch()` 使用 playwright-core 启动 headless Chrome；`openPaired()` 建立独立 context，通过配对码登录，并等待侧栏出现。默认视口为 1280×800。
- `assertNoPageErrors(page, whitelist)` 检查控制台 error、未处理页面异常和 CSP 违规；白名单接受正则或正则数组。
- `screenshot(page, name)` 仅在 `PANE_SCREENSHOTS` 设置为目录时保存整页截图，文件名为 `<name>.png`。目录不存在时自动创建。

`test/web-logic.test.mjs` 在 Node.js 24 中直接导入前端 `.ts` 模块。浏览器交互、生产设备密钥与 Node.js 补充签名测试的关键断言见[自动化验收映射](#自动化验收映射)。

`test/fixtures/ui-extension.ts` 提供 `/pane-dialogs`、`/pane-dialog-timeout` 和 `/pane-widgets`，分别触发顺序对话框、1500 毫秒超时选择框和扩展组件请求。调用方从 `helpers.mjs` 导入 `providerPath` 与 `uiExtensionPath`，以 `startServer(fixture, { extraExtensions: [providerPath, uiExtensionPath] })` 加载；`piFixture()` 不默认加载此扩展。对话框测试须在启动服务前将 `fixture.env.PANE_UI_LOG` 设置为临时现场中的日志路径。扩展将每个结果以 `{method,result}` JSONL 追加到该文件，取消或超时的 `undefined` 结果记录为 `null`。

`test/fixtures/fake-provider.ts` 的 `waitForFile` 片段等待指定文件出现，并响应取消信号；日志中的 `waiting` 记录表示模型已进入门闩。浏览器回归通过临时现场中的文件解除门闩，控制当前回合的结束时机，避免用固定延迟猜测排队窗口。

`test/fixtures/ui-plugin/` 是插件界面测试用的插件（id `uitest`，显示名称“测试插件”），与服务端同进程加载，测试通过 `globalThis.__uiPlugin` 增删节点、推送会话事件、发布表单和横幅、发送通知、让取快照失败或让动作超时。以 `startServer(fixture, { plugins: [<该目录>] })` 加载。`test/fixtures/ui-plugin-2/`（id `uitest2`）是第二个插件，节点挂在 `uitest` 的节点下、侧栏面板与 `uitest` 同名，另有一个资源节点及其节点面板，用于跨来源的树、按来源区分的面板和资源节点的点击，测试通过 `globalThis.__uiPlugin2` 推送面板变化。

构建后可执行：

```sh
node --test --test-concurrency=1 test/web-*.test.mjs test/ui-extension.test.mjs test/reconnect.test.mjs
```

设置 `PANE_SCREENSHOTS` 可保留浏览器测试截图；`PANE_UI_LOG` 用于核对真实 pi 扩展收到的对话框响应，两者均不改变生产配置。

## HTTP 接口

所有请求校验 Host；带 Origin 时也校验 Origin。只有 `GET /api/instance`、`POST /api/auth/pair` 和可选的静态 Web 资源无需浏览器凭证。其他 `/api/*` 请求使用 `Authorization: Bearer <credential>`。

| 接口 | 内容 |
| --- | --- |
| `POST /api/auth/pair` | `{code}` 换取 `{credential, instanceId}` |
| `POST /api/auth/code`、`POST /api/auth/logout` | 已登录浏览器生成新码、吊销当前凭证 |
| `POST /api/ws-ticket` | 获取 30 秒一次性 ticket |
| `GET /api/sessions` | `PaneSessionList`，含名称、标题、ISO 时间、父会话文件、`hosted` 和已登记会话的 `status`；不含消息全文。与插件协议共用会话目录，字段对应见 [architecture.md](architecture.md#会话列表) |
| `POST /api/sessions/open` | `{requestId,cwd,sessionFile?,fork?}`；只读打开，省略文件时预分配路径；并发同路径复用已登记记录，服务关闭时返回 503 serverStopping |
| `GET /api/sessions/:id/snapshot` | `PaneSessionView`；附带 `cwd`、`sessionFile`、`hosted`、最近的 pane `state`、实际项目信任状态和 hold 原因；打开会话也使用该视图 |
| `GET /api/sessions/:id/history?before=<id>&limit=50` | 按父链读取更早的聊天分支条目 |
| `POST /api/sessions/:id/control` | `{requestId,expectedEpoch,expectedRevision,command,draft?}`；普通控制串行、停止优先和幂等 |
| `POST /api/sessions/:id/query` | `{type:PaneQueryType}`，`type` 为 `state`、`models`、`commands`、`stats` 或 `forkPoints`；响应为 `PaneQueryResults[type]`，不含 RPC 信封；pi 拒绝时返回 409 `rpcRejected` |
| `GET /api/sessions/:id/drafts`、`POST /api/sessions/:id/drafts/:recordId/claim` | 服务端保存的清出草稿 `PaneSavedDraftsList`；`{requestId}` 领取一条记录，原子地删除并返回 `PaneClaimResult`，见 [architecture.md 的“服务端暂存的清出草稿”](architecture.md#服务端暂存的清出草稿) |
| `POST /api/sessions/:id/ui` | `PaneUiAnswerRequest`：`{requestId,expectedEpoch,id,answer?}`；`answer` 为 `{value}` 或 `{confirmed}`，省略表示取消；种类或选项不匹配时返回 400 `invalidUiAnswer` |
| `GET /api/exports/:id` | 下载本实例生成且未过期的 HTML；需要凭证；文件位于数据目录的 `tmp/exports/`，24 小时后清理 |
| `GET /api/trust`、`POST /api/trust/:id` | 待答信任询问、`{requestId,decision?:{trusted,remember}}`；省略决定表示关闭询问 |
| `POST /api/assets` | multipart 的 image、thumb；X-Request-Id 作为幂等键 |
| `POST /api/assets/touch` | `{requestId,assetIds}` 延长资源期限 |
| `GET /api/assets/:hash`、`GET /api/assets/:hash/thumb`、`GET /api/blobs/:hash` | 带凭证按哈希取图 |

`/query`、`/ui`、控制结果和会话列表使用 `web-api.ts` 定义的 pane 类型；pi 原始 RPC 形状仅在服务端使用，会话流和 entries 遵循 plugin-api.md。

控制命令包括 prompt、steer、follow_up、stop、close、restart、set_model、set_thinking_level、compact、new_session、fork、clone、set_session_name、export。`export` 使用普通控制队列，校验 `expectedEpoch` 和 `expectedRevision`；服务端向 pi 发送 `export_html`，固定 `outputPath` 为数据目录下 `tmp/exports/<128 位随机 base64url id>.html`。下载标识必须为规范的 22 字符 base64url，且已由本实例生成；响应类型为 `text/html; charset=utf-8`，以 `pi-session.html` 作为附件文件名。

`prompt` 可带 `delivery: "steer" | "followUp"`，由 `web-adapter.ts` 映射为 pi RPC 的 `streamingBehavior`，用于运行中技能、提示模板展开后的送达。扩展命令立即执行，忽略送达字段。非 `prompt` 命令携带 `delivery`，或字段值无效时，返回 400 `invalidCommand`。`delivery` 参与原请求的幂等内容摘要；同一 `requestId` 改变该字段返回 409 `idempotencyConflict`。

`Sessions.command` 在启动 pi 前检查 `prompt`、`steer`、`follow_up` 的实际消息文本，草稿按编码结果检查。命中终端专用名单时，未托管会话直接返回 400 `unsupportedCommand`，不创建运行记录、不发给模型；已托管会话每次查询 `get_commands`，同名扩展、技能或提示模板优先，否则拒绝。名单依据、命令分工和拒绝提示见 [architecture.md 的“斜杠命令”](architecture.md#斜杠命令)。

控制受理结果为 `{status:"accepted",snapshot,result?}`。`result` 仅包含 `handled`、`cancelled` 或 `exportId`；输入被扩展消费时 `handled` 为 true，`new_session`、`fork`、`clone` 被取消时 `cancelled` 为 true。`stop`/`close` 的 `done` 结果只含 `clearedText`、`clearedDrafts` 和可选的 `uncertainDrafts`，停止诊断由服务端内部 `reports` 保存。图片使用草稿节点，不接受命令中直接提供 base64 images。restart 只用于中断的会话，不允许借重启绕过最近修改警告或其他宿主写锁。上一个写者状态不明时，浏览器须经用户确认后才能在 restart 命令中附上 assumeNoWriter: true。

`/bridge/launch` 和 `/bridge/event` 是独立的进程级 Agent 通道，不能使用浏览器凭证；其 token 也不能调用 `/api/*`。

控制命令的 HTTP 等待默认 30 秒，超时返回 pending；底层 RPC 继续跟踪实际响应，同一 requestId 不会因等待到期而固定成失败。传输中断，或停止失败后主动终结本地等待，导致无法确认结果时返回 rpcResultUnknown，客户端须读取状态核对。stop、close 和 restart 不等待挂起的普通控制操作，检查前置条件后抢占；未执行项返回 controlPreempted，活动 RPC 按真实响应、传输关闭或停止失败后的本地等待终结记录结果；最后一种只记为结果未知。排队及 pending 超限返回 429，具体额度与停止通道见 [architecture.md 的“停止与控制队列”](architecture.md#停止与控制队列)。命令受理只递增 revision，生成阶段按实际事件更新；handled 输入、预检拒绝和手动压缩失败不会使空闲会话持续显示 running。已确认的控制响应不受后续状态查询或锁清理故障影响。

首次发送才启动 pi。服务端暂停输入直到 bridgeReady 和初次 RPC 状态/条目读取完成。启动就绪失败的响应在停止、身份复查和写锁处理完成后返回；停止失败时保留锁及运行记录，不因失败响应提前解锁。新会话的真实 pi id 在首次启动时确定；调用方使用响应快照或 pane_session_replaced 的 newRef 更新引用。

服务关闭先封闭实例共用的 Inflight 门禁，新的打开、控制、RPC、UI 回应及 bridge 事件返回 serverStopping。全部会话同步标记关闭，各写者并行请求停止。统一屏障覆盖已受理 open/probe、在途启动、取锁及 spawn、目标取锁、初始化、持久化、RPC 和 bridge 身份核查；`sessions.close.settle` 也登记停止本身、局部 drain、启动及 handle 收尾，不能先在屏障外无限等待。

关闭一定有界完成或拒绝：停止与全部在途操作排空共用 `ceil(abortTimeoutMs + graceMs + termGraceMs + 9000)` 毫秒，默认 **27000 毫秒**。HTTP/WebSocket 关闭、实例锁释放再分别最多等待 **5000 毫秒**，默认总等待上限 **37000 毫秒**。配置必须可表示为合法 Node.js 定时器；异步期限以事件循环可以运行作为前提。停止失败时，handle 主动终结全部 pane 本地 RPC 等待，未确认的控制结果缓存 `rpcResultUnknown`，不假定远端执行结果，也不修改 hostkit 传输。正常停止仍由真实响应或管道关闭结束等待。

停止/排空超时返回含 `shutdownTimeout` 的关闭失败，错误消息和 `detail.pending` 列出剩余登记的 kind 和调用栈来源；超时不删除登记、不允许进入实例锁释放。成功或失败关闭均进入 HTTP/WebSocket 收尾。清理未确认时保留实例锁、尚未释放的写锁及运行/恢复记录；超时失败闩禁止迟到停止成功再进入写锁释放或记录删除，现场交给下一实例恢复或维护者。已经进入的原生操作不能撤销，实例锁释放超时只报告未确认。并发及重复 close 返回同一个 Promise 和失败，迟到成功不能改变结果。

停止失败由 handle 缓存，退出回调摘下 handle 或其他写者成功重启不能清除失败；独立登记须等停止及排空均成功才删除。本实例新产生的恢复隔离和创建 handle 前的清理失败由实例登记保存，关闭时汇总；启动前已有的隔离标记保留为 `Sessions.recoveryDiagnostics`，CLI 输出诊断，正常关闭照常成功。完整预算、失败闩和入口对照表见 [architecture.md 的“统一关闭屏障”](architecture.md#统一关闭屏障)。

hostkit 调用的拒绝若通过 `cause` 或 `errors` 携带停止报告、清理失败消息或多错误聚合，调用边界立即通知本实例，后续 release、stop 或 drain 成功不能清除登记。完整报告随拒绝交付也保留，因为拒绝可能来自独立身份查询失败。固定依赖的 `spawnManaged` 启动回收没有专用错误码，多错误聚合按清理未确认保守处理；判定器仅用于 hostkit 调用边界，并防止循环上下文导致无限遍历。普通未启动错误、参数错误及业务拒绝不单独登记。取得 handle 前的 release、实际停止和迟到目标清理的拒绝仍全部保留。锁探测会短暂持有原生锁，其 finally 释放失败没有独立标识，因此 probe 的所有拒绝均保守登记。

## WebSocket

连接 `/ws` 后，第一帧为 `{type:"auth",ticket,paneProtocol:[1,1]}`。五秒内没有有效首帧即关闭，拒绝后不再处理任何帧。鉴权后第一条消息为 `banners`，包含当前横幅、协商版本和 connectionId，随后逐条重发当前持久表单。

订阅：`{type:"subscribe",ref:{source:"pane",id},after:{epoch,seq}}`。取消订阅：`{type:"unsubscribe",ref}`。事件使用 plugin-api.md 的会话流形状。

扩展 UI 通过 `{type:"ui_request",ref,request:PaneUiRequest}` 推送，以 `kind` 区分对话框、通知和编辑器状态。`level` 默认 `info`，`widget placement` 默认 `aboveEditor`。服务端在收到带 `timeout` 的 pi 对话框时计算 `expiresAt`，重订阅补推时保留同一期限。回答、取消、到期、写者退出或会话切换时，向该会话的所有订阅者推送 `{type:"ui_resolved",ref,id,reason}`，`reason` 分别为 `answered`、`cancelled`、`expired` 或 `closed`；到期仅清理服务端待答记录，不向 pi 发送回答。过期或已处理的回答返回 `alreadyHandled`。

信任询问通过 `{type:"project_trust",request:{id,cwd,expiresAt}}` 推送，回答或到期后广播 `{type:"project_trust_resolved",id}`；没有浏览器时返回 undecided，不把它等同于不信任。

CLI 的静态目录默认是相对 server dist 的 `../../web/dist`，可用配置文件 `webRoot` 覆盖。目录不存在时服务仍可启动，非 API 路径返回 404“Web 界面未构建，请运行 npm run build”。

插件的 HTTP 路由、非 `pane` 会话订阅、树订阅、设备注册与用户在场回应统一定义在 [architecture.md](architecture.md#插件-http-接口)。M3 的 v1 兼容扩展包括 `formRemoved.source` 与 `presenceClosed.reason`；持久表单按完整 `(source, formId)` 隔离，并在启动、树 reset 与浏览器连接时对齐；签名由插件后台验证。

每会话保留最近 2000 条事件，并用 32 MiB 字节限额限制缓冲；单条事件仍可保留。发送缓冲达到 1 MiB 时合并连续文本增量；达到 8 MiB 时以 resync 替换待发会话增量。非会话消息仍积压超过 1 MiB 时关闭慢连接。浏览器慢不会阻塞 RPC stdout。

## 自动化验收映射

| M1 验收项 | 测试文件与断言 |
| --- | --- |
| 1. 流式输出中 pi 被杀 | failures：保留 unfinishedPartials、interrupted、再次发送恢复 |
| 2. 流式输出中服务端被杀 | failures：真实子服务端被强杀；重启先按身份停止；旧凭证与 ticket 拒绝；重新配对与磁盘一致 |
| 3. 断电截断尾行 | failures：旧 mtime 的截断原文件直接托管并 settled，原完整条目及新消息保留、重新解析只诊断原截断行；另测只读 fork 不改源；core：v1/v2/v3 迁移与源文件哈希 |
| 4. 流式输出断网重连 | reconnect：Node 和真实 headless Chrome 的游标连续、无重复、最终条目与磁盘一致 |
| 5. requestId 幂等 | trust：首次发送的 pending、最终结果与内容冲突；resume 信任回答晚于缩短的 RPC 等待期限仍能得到真实最终结果；rpc-results：连接中断时结果未知；confirmed-results：取消切换后查询或释放失败不覆盖已确认结果，重复 requestId 仍返回真实响应；control-admission：准入超限不删除 pending，停止额度独立；failures：stop 幂等；core：等待超时、保留期限与序列化 |
| 6. 并发控制 | failures：send/send、send/stop、model/send 三组均断言 revisionChanged、败方无副作用；新快照和新 requestId 重试只执行一次，重复重试复用结果 |
| 7. 重启后的旧凭证 | failures、auth、http：实例变化、旧凭证和 ticket 拒绝、吊销关闭旧连接 |
| 8. abort 不响应 | failures：真实假 provider 忽略 abort；rpc-results：扩展命令永久挂起后，经 pane stop/close 抢占，进程退出、等待项结束、旧请求缓存 rpcResultUnknown、未执行项缓存 controlPreempted；stop-switch-races：切到已打开 B 后仍挂起的活动队列随写者迁移，B.stop 可抢占；真实取锁在停止后才返回时不登记 writer，释放迟到锁；已进入的持久化写入结束后清理运行记录及临时文件；platform：忽略取消的工具启动真实 shell 和脱离进程组后代，强制终止后独立核对身份、coverage 和 leftovers |
| 9. 扩展命令切换会话 | switches：替换事件、旧视图只读、旧状态拒绝、reload 后持锁；A resume 到已订阅 B 时保留模型、客户端及 hold，B 收到 resync 和后续输出；stop-switch-races：persist 入口 gate 固定停止完成后才放行，覆盖停止和停止后重启 A 两种顺序，B 保持只读、旧记录不重建、新 handle 不迁移；另覆盖旧锁释放等待、切换代次变化、旧 shutdown 失败、旧回调、start 迟到返回及原始启动故障、控制后状态查询及只读文件读取的生命周期隔离；stat gate 验证迟到 open 不覆盖已托管记录、服务关闭后不登记，以及关闭遍历期间禁止迟到重绑定而漏停写者；trust：跨目录 resume |
| 10. agora 与 pane 写锁互斥 | switches：独立进程用 hostkit 以 pi-agora 身份持锁，pane 只读且拒绝发送 |
| 11. pane-bridge 未就绪 | bridge-failures：无效/抢先兑换 ticket、服务端拒绝、无就绪、新实例 reload/new 不就绪或断开；在每个定时 new/resume/fork 的 shutdown 及实际 session_start 窗口核对目标共享记录、持锁及存活 writer；协调离线时三种操作均取消；输入审计、停止和再次取锁 |
| 关闭与在途启动 | shutdown-start-races：真实写锁 acquire 与真实 spawn 返回 gate 均位于 start 返回且 ready 之前；关闭不能提前成功或释放实例锁，放行后无存活写者、运行记录或持有写锁，取消后的取锁不 spawn；信任询问、目录读取、restart 同样登记；resume、reload、已退出 handle 的迟到目标锁及重连初始化均排空；真实 performStop 内注入停止、核查、锁更新、锁释放及运行记录清理失败，等 onExit 和独立登记收尾后再关闭，断言失败及保留实例锁；成功重启不能清除旧失败；启动/切换恢复失败、spawn 后释放失败由实例登记保留；经过真实 spawnWriter → stopFailedWriter 注入 running 记录提交失败及不完整报告或无报告停止拒绝，根进程退出且 release 成功后仍须拒绝关闭，并输出注入前的原始 StopReport；普通未创建进程的 spawn 拒绝在真实写锁释放后允许关闭；acquire、目标 update、被忽略的 clear_queue 以及切换后 release 携带报告的拒绝，即使后续清理成功也保留实例锁；旧隔离只诊断且不阻止下一实例正常关闭；并发关闭共享结果；单元级重绑定同步测试验证旧记录重新托管后真正执行 get_entries |
| 统一关闭屏障 | shutdown-open-races：在真实 probe 的目录准备阶段暂停，确认 close 未完成且实例锁未释放；放行后执行真实原生锁取得和释放，释放拒绝必须导致并发及重复 close 失败，健康并发正常关闭；关闭开始后的新 open 返回 serverStopping，未进入 probe 准备或原生锁；shutdown-inflight：真实写者停止并排空后，在途 RPC 仍由统一屏障等待，迟到清理事实阻止实例锁释放，普通成功不误报；inflight：同步门禁和登记、成功及同步/异步拒绝的移除、资源 owner 收尾、迟到子操作及终止阶段检查 |
| 有界关闭与停止失败 | shutdown-bounded：真实 /pane-test-hang 已进入扩展后，在真实 proc.stop 边界分别注入拒绝、存活 leftovers，断言有限时间内 close 拒绝、全部本地 RPC 等待结束、控制结果及重放均为 rpcResultUnknown、HTTP 停止监听、写锁及运行记录和实例锁保留；健康强停仍结束挂起 RPC 并关闭成功；停止边界和额外生产者永久 pending 时到期失败，列出 kind/来源且不释放实例锁；超时后放行真实 proc.stop，进程退出仍保留写锁与运行记录；仅停止后登记永久 pending 同样到期失败；网络回调和实例锁释放永久 pending 分别限时拒绝；inflight：超时不删除登记、迟到排空不能解除失败闩或进入 finalize |
| 恢复报告隔离 | writer-recovery：真实存活旧 pi 被按身份恢复后，在真实报告上注入 snapshot 不完整；首次拉起和目标切换均拒绝该报告，保留旧身份、stopping 锁和诊断；recovery-failure：在真实停止报告后注入故障，执行 hostkit 原有 failed/throw 解锁分支，检查旧共享记录、存档、重启隔离，另一宿主未恢复不能 spawnWriter 且必须再查旧写者 |
| handled 与拒绝 | input-state：无模型扩展命令、handled 输入、prompt 预检拒绝保持 idle；compaction-state：空会话 compact 拒绝、扩展取消、provider 失败均由手动结束事件恢复 idle，可按空闲规则回收；自动压缩仍等待 settled |
| 协议边界 | core、http：空、单元素、多元素、非整数及非数组版本范围均拒绝，首帧带实际协商版本；通用类型声明不导出 pi 原生信封，任一原生信封重新导出的负向断言必须失败 |
| 鉴权边界 | auth、http：Host/Origin、错误与过期配对码、ticket 一次性与过期、首帧、无 Cookie、安全响应头 |
| 图片与快照 | images：4 MiB 单图、10 图 12 MiB 实测、MIME 和超限拒绝、get_entries since、引用无 base64、缓存缺失重建、停止时取回两条带图片的草稿；core：全部大小边界、顺序与清理 |
| 项目信任 | trust：启动前询问、记住选择、保存 false、跨项目切换时及时询问、等待用户超过默认十秒仍保持写锁、无连接和超时返回 undecided |
| 列表与回收边界 | store：环境/项目/全局目录优先级、默认项目分目录、已知项目在重启后保留；backpressure：慢连接合并与 resync，不阻塞其他连接 |

### M2 前端核心

下表列出真实 Chrome 端到端场景及补充的协议、纯逻辑测试；测试定义不等于本机或三平台 CI 的执行结果，运行时须确认 Chrome 未被跳过。

| M2 验收项 | 测试文件与关键断言 |
| --- | --- |
| 配对 | `test/web-e2e-conversation.test.mjs`：配对后显示侧栏，地址栏移除配对码；`test/web-e2e-tabs.test.mjs` 通过共用 fixture 断言新标签页经 BroadcastChannel 取得同一凭证 |
| 新建会话并完成一次对话 | `test/web-e2e-conversation.test.mjs`：页面新建、首次发送、信任询问后收到假 provider 完整回复，回复与磁盘一致，侧栏显示会话 |
| 流式中断网再恢复 | `test/web-e2e-conversation.test.mjs`：Chrome 离线期间服务端游标继续推进；恢复后只显示一条完整回复，逐字与磁盘一致；`test/web-logic.test.mjs` 验证重复、跳号、epoch 和 resync |
| 停止并取回排队消息 | `test/web-e2e-conversation.test.mjs`：两条纯文本 follow-up 按原顺序前置到现有草稿，队列消失，provider 收到 abort 且未执行排队请求；带图片的浏览器取回见“审查回归 Q1–Q4”和“取回草稿的结束路径” |
| 扩展 UI 对话框 | `test/web-e2e-extension.test.mjs`：select、confirm、input、editor 的值与真实扩展日志一致；1500 毫秒超时关闭并记录 null；通知、widget、编辑器文字及跨标签页回答同步 |
| 图片占位符往返 | `test/web-e2e-images.test.mjs`：两图上传资源与红、蓝原图哈希对应，复制为交错草稿，发送后磁盘块顺序与图片字节逐一对应，历史图片加载；粘贴恢复、退格重新编号和原生撤销/重做均有断言 |
| 两个标签页并发发送 | `test/web-e2e-tabs.test.mjs`：真实 409 `revisionChanged` 后草稿放回输入框且不自动重发，用户选择 follow-up 后以新 requestId 发送，模型与页面都只出现一次 |
| 服务端重启后旧标签页回到配对页 | `test/web-e2e-tabs.test.mjs`：同端口重启改变 instanceId；旧页仍持旧凭证时新页不能继承；旧页收到真实 401 后清除 sessionStorage，两个页面均显示配对页 |
| 设备密钥 | `test/web-device-key.test.mjs`：首次配对且未打开设置时生产 IndexedDB 已有不可导出 P-256 私钥，重载保留同一密钥，设置 ID 对应公钥哈希，Node 验证浏览器签名；并发初始化等待同一 Web Lock。Node 补充测试直接调用生产 `signPresence`，核对默认域、JCS 字节、P1363/base64url 编码、篡改拒绝和缺失密钥 |
| 斜杠命令 | `test/web-e2e-extension.test.mjs`：内置与扩展命令补全、方向键、Tab 和拒绝 `/settings`；`test/web-e2e-regressions.test.mjs`：未托管时拒绝终端命令、运行中扩展命令固定走 prompt、内置命令冲突保留参数 |
| 渲染安全与 CSP | `test/web-e2e-conversation.test.mjs`：恶意 HTML 与 javascript 链接按文本显示，无危险元素、属性或链接，代码块高亮；`test/fixtures/web-e2e.mjs` 在收尾检查页面异常、控制台 error 与 CSP 违规，预期网络或 409 错误须逐项列入白名单，图片编辑场景也使用该检查 |
| 审查回归 R1–R7、R9 | `test/web-e2e-regressions.test.mjs`：快速切换提交末次草稿、慢 touch 保留编辑（R1）；命令分发与冲突（R2）；两页名称/思考同步（R3）；离线待答对账、UI/信任回答失败保留与同请求重试（R4）；真实执行后丢弃 HTTP 响应仍只执行一次（R5）；迟到 open 不改当前选择与 lastSession（R6）；持久化工具卡片显示第二次等长 partialResult（R7）；旧快照挂起时同会话新导航和另一会话均继续收取最终事件（R9） |
| 审查回归 R8、R10、R11 | `test/web-device-key.test.mjs` 检查登录初始化、跨页串行化与生产签名路径（R8、R10、R11）；`test/web-e2e-images.test.mjs` 比较原图与磁盘图片字节哈希，交换两图必须失败（R11） |
| 审查回归 N1–N4 | `test/web-e2e-regressions-2.test.mjs`：运行中提示模板分别通过“排队”与 Enter 送达，展开后进入队列并在当前回合结束后执行；未启动时 `/trust` 被服务端拒绝且保留输入，同名 `debug` 扩展正常执行，`/quit` 的真实 409 保留输入（N1）；挂起旧 state 查询和旧 accepted 快照，另一页更新后思考按钮仍保持新值（N2）；真实 200 控制响应的 JSON 截断后以完整相同请求体重试，provider、磁盘与页面均仅执行或显示一次（N3，覆盖 `invalidResponse`，不模拟 TCP 读取中断）；A 的真实 409 晚于导航 B 到达时，不弹重发确认、不重取 B、不向 B 发消息（N4） |
| 审查回归 Q1–Q4 | `test/web-e2e-regressions-3.test.mjs`：参数模板与固定模板附图排队后停止，原 `assetId`、图片节点和顺序恢复，两条同文字按先进先出对应，重新发送后磁盘图片哈希一致（Q1）；两页打开同一会话，一页关闭后两页都显示未启动、不再查询 `notHosted`，再次发送正常启动（Q2）；重启与关闭确认期间导航到其他会话后不再提交（Q3）；两次信任快照乱序时已回答的询问不复活（Q4）；editor 对话框出现后立即填写的内容不被预填值覆盖。`test/web-protocol.test.mjs`：steer、follow-up 与带 `delivery` 的 prompt 四种路径的 `clearedDrafts` 含图片节点 |
| 取回草稿的结束路径 | `test/web-e2e-stop-restore.test.mjs`：扩展改写的图片草稿与纯文字排队后停止，确定的与归属不明的草稿按顺序前置到现有草稿，立即写入草稿存储，不出现确认框；归属不明的提示显示在输入框上方，刷新后仍在，切到其他会话不显示，删除部分内容不改变，清空输入框后移除且不复活；A 的停止或关闭响应晚于导航到 B 时，B 正显示的确认框不被替换，B 的输入框和提示不受影响，A 的草稿存入 A 的待放回记录，回到 A 后放回并删除记录，点“知道了”后提示消失、刷新后也不出现；待放回记录在服务端同端口重启、重新配对后回到原会话输入框；有排队消息时执行 `/quit`，关闭后输入框只有取回的草稿（R9-3）；`localStorage` 写入抛出 `QuotaExceededError` 时草稿留在内存，回到原会话后放回并显示错误提示，B 不显示（R9-1） |
| 提交即清空 | `test/web-e2e-stop-restore.test.mjs`：执行 `/quit`（含带尾换行）后输入框和原会话草稿存储立即清空，内容存为在途提交，关闭响应前切走、切回，原会话都只有清出的草稿；消息送达前重新输入同样的文字，迟到的成功响应不清掉新草稿；服务端拒绝时内容放回原会话、排在期间新写的内容之前，切走后失败则进入原会话的待放回记录，服务端内部错误时放回并提示无法确认；提交后、结果返回前刷新页面，内容回到原会话并提示。`test/restored-drafts.test.mjs`：送达丢弃、失败原样放回、结果无法确认时标记归属不明、输入框未挂载时进入待放回记录；页面关闭后遗留的在途记录按锁是否仍被持有取回，保护期内的稍后再查，没有 Web Locks 时只取超过时限的记录；提示的累加与按时间移除；挂载时直接放回、未挂载时每批独立保存、多批都含归属不明项时逐条标记（R9-5）、同一毫秒内存入的多批后到的在前、会话 id 互为前缀（`a` 与 `a.b`）及含孤立代理项时不串会话、不出错，取走旧批期间写入的新批不被删除（R9-6）、配额不足时内存暂存与写回、写入失败保留记录、损坏记录清除、注销旧输入框不影响新挂载。`test/queue-mirror.test.mjs`：停止快照后扩展追加消息时按最少追加项对齐，唯一认领、分组认领、保留或删除图片标记、窗口内消费与同文追加的归属 |
| 清出草稿不丢（#10、#11、#17） | `test/web-e2e-durable-drafts.test.mjs`（Chrome）：排队的图片与文字草稿在服务端关停（`server.close()`，即 Ctrl+C 调用的路径）时以 `shutdown` 记录保存且未发送；同端口重启、重新配对后两个标签页打开该会话都显示待取回条（来源、文字预览、图片数），不自动放回，关停前的页面仍开着时不收养它的草稿；一页点“放回输入框”后草稿进入这一页，两页的条都消失，另一页的输入框不变，提示只在放回的一页；关闭关停前的页面后，另一页回到前台时收养它的草稿（接在本页内容之前、提示、删除原键），放回的一页不受影响；刷新、切换会话后各页草稿保留、不重复、不再出现条。停止已执行、结果返回前刷新发起页面：发起页等待期间不显示这条记录，另一独立浏览器配置显示；刷新后发起页显示待取回条、不自动放回；两边同时放回，服务端只给一边 `claimed`，另一边 `gone` 并提示，草稿只进入一边的输入框，领取后再刷新不重复。两页同一会话各写各的草稿，各存在自己的键中，互不覆盖，刷新沿用 tabId、草稿仍在；停止成功时发起页领取并直接放回、不显示条，另一页的输入框和草稿不变；复制标签页（`sessionStorage` 中的 tabId 与原页相同）换新 tabId，看不到也不覆盖原页的草稿；关闭另一页和复制页后，本页重新打开该会话时收养两者的草稿，被收养的键删除；末尾换行、连续换行和图片前后的换行写入输入框再读出不变。重启后两页先后打开会话，打字前断言输入框可编辑，不可编辑时输出输入框状态、tabId 和草稿键。输入后立即刷新，草稿仍在，另一页等到锁释放 3 秒后也不收走刷新页面的草稿；输入后立即关页，另一页不经切换会话或回到前台即收养，被收养的键删除。领取响应被扣住（服务端已领取、列表推送已去掉该条）时本页仍显示这一条，刷新后标“领取结果未知”，“重试”沿用原 `requestId` 拿到含图片的草稿，之后删除 `sessionStorage` 中的记录。一页停止、结果返回期间另一页连续打字（防抖期间一直有未保存的编辑）：放回的草稿留在发起页并写入它的键，另一页的输入和键不受影响；“放弃”先确认，取消时记录保留，确认后两页的条都消失、输入框不变，提示只在放弃的一页。`test/saved-drafts.test.mjs`：领取在网络中断时用同一 `requestId` 按 0.5、1、2、4 秒退避重试，退避截在 120 秒的总期限处、期限外不再发请求，抛出 `claimTimeout`；`pending` 时每秒查询、不超过期限；挂住的请求在总期限到时中止，再次领取同一记录沿用原 `requestId`、取回服务端迟到完成的结果，领到之后换新的 `requestId`；其他错误不重试，确定的错误响应（如 500）丢掉原 `requestId`、下次换新的，网络中断到期限后沿用；领取响应丢失、列表已去掉该条时，结果未知的领取仍在条目中，“重试”沿用原 `requestId` 放回草稿，放弃的重试不再确认；结果未知的领取按 tabId 存入 `sessionStorage`，刷新后恢复并能重试，其他 tabId 的项删除；领取中只有该记录忙碌，同一会话的其他记录和其他会话可以领取；乱序到达的旧列表丢弃，读取失败保留已显示的列表；放弃的确认期间切换会话不执行、取消不执行；放回、放弃、已被领取的结果迟到时不在其他会话提示，放回的草稿仍交给原会话。`test/restored-drafts.test.mjs`：草稿按标签页分键、两页各写各的，会话 id 形如 `A.<tabId>` 的旧键与会话 `A` 的新键不同；收养时锁被持有（标签页仍开着）跳过并返回它的 tabId，取得锁时放在本页内容之前、先写本页的键再删原键，锁内重读、已被收养走的不再收养，输入框已切换会话时不收养；本页写入失败时保留原键、不重复收养、之后写入成功时在原主的锁内删除原键，原主的锁被持有时不删、锁释放后再删，原键的值变化时不删并按新内容重新收养；旧版共用键在锁内收养，会话 `S.<tabId>` 的旧键不当作会话 `S` 的标签页键；没有 Web Locks 时不收养任何键；等待其他标签页关闭时锁释放即调用并立即释放锁，撤销后不再调用。`test/tab-identity.test.mjs`：新页面分配 tabId 并持有锁，刷新沿用（旧页面稍晚释放锁时同样沿用），复制标签页等待后换新；没有 Web Locks 时每次加载换新 tabId。`test/durable-drafts.test.mjs`：存储格式、哈希文件名、0600 权限（Windows 不检查 POSIX 权限位）、按会话隔离、损坏文件和非目录项跳过、保存和领取时通知所属会话、领取返回内容且只能领取一次、不能跨会话领取、过期记录与临时文件清理、领取中文件按名称中的时间清理；并发领取同一条只有一个拿到；清理、领取与保存并发 200 次保存都成功；被记录或领取中文件引用的图片 29 天后仍在，领取时刷新使用时间、之后按 7 天期限清理；草稿接口未鉴权 401、Host 或 Origin 不符 403、同一 `requestId` 领取不同记录 409；记录过期被清理时通知所属会话，损坏的过期文件删除但不通知；附件扫描在读取前记录被改名为领取中文件时重扫并计入，领取中文件已删除时领取已刷新使用时间、图片不被清理，目录持续变化 5 次后放弃本次附件清理；读到尚未写完的临时文件时重扫、从写完的记录计入，领取中文件改回记录时重扫并计入，无法解析的临时文件一直在时放弃本次附件清理；真实 pi 排队后关停保存原草稿（含图片节点，steering 在前），重启后未打开的会话可读取，订阅生效后补推一次 `drafts_changed`，订阅的连接在领取时再收到一次，领取后不再返回，其他请求领不到，同一 `requestId` 重试得到同一份内容；`stop`、`close` 以 `requestId` 保存且只保存一条，结果带 `draftsRecord`，返回前已推送 `drafts_changed`，同一请求续取得到原结果，重启后旧 epoch 被拒绝、不重新执行，记录仍可领取；关停时 `clear_queue` 响应迟到（pi 已清空队列），全部草稿作为归属不明保存；停止时第一次 `clear_queue` 失败、写者停止流程的第二次清出了仍在队列中的两条，只有停止请求的一条记录；保存挂起时停止在 2 至 8 秒内返回、结果不带 `draftsRecord`，同一会话的读取和领取在 1 秒内完成；保存挂起时关停在 2 至 8 秒内完成并停止 pi 进程；CLI 收到 SIGINT 后退出（Windows 跳过）。`test/restored-drafts.test.mjs`：其他页面持有锁的过期在途提交每秒重查，锁释放后取回（#17） |
| 草稿初始化与信任快照 | `test/web-e2e-regressions-2.test.mjs`：连续五次新建后立即 fill 和 Enter，核对首次提交目标、provider 次数和磁盘消息；重连的旧空信任快照晚于新项目 `.pi/settings.json` 触发的实时询问，补取快照后保留信任框，回答后真实 pi 完成启动 |

`test/web-api.test.mjs`、`test/web-protocol.test.mjs` 验证 pane 类型转换、查询、控制结果、导出鉴权和 UI 回答生命周期。`web-protocol` 还验证未托管终端命令被服务端拒绝且无运行记录和模型请求、已托管的同名 `debug` 扩展命令立即执行、隔离 agent 目录下 `prompts/*.md` 模板在运行中按两种 `delivery` 展开排队、缺少送达字段时由 pi 拒绝，以及字段校验与幂等内容冲突；`test/web-state-sync.test.mjs` 验证状态缓存提交、事件合并及代次隔离。这些接口测试不能替代对应的浏览器交互测试。

### 共用测试约定

测试的 RPC 输入审计通过观察已有 data 事件记录命令，不添加 stdin 的 data listener，也不调用 resume/read，避免在 pi RPC reader 注册前开启 flowing 并吞掉初始化输入。fixture-audit 验证 reader 注册前缓冲保留、JSONL/UTF-8 分块及字节原样转交；bridge-broker 验证最新实例 fencing 和就绪幂等；hostkit-cleanup 验证嵌套报告、无报告清理错误、多错误聚合、循环上下文、普通拒绝及观察器的原样传播。stop-switch-races 的只读读取 gate 阻塞同源文件的全部 watch 读取，避免后续读取先完成并推进 epoch；只读文件变化导致模型重建时，旧 epoch 的控制请求返回 409 epochChanged 属于正常隔离行为。其初始化拒绝会关闭已经启动的真实写者、HTTP 和实例锁；迟到启动 gate 同时交付就绪成功与失败，避免初始化异常遗留监听服务或让测试永远等待 entered。

测试文件路径均为 `test/<名称>.test.mjs`。三平台都运行服务端测试，不用模拟进程替代真实 pi。Chrome 路径由本机安装或 CHROME_PATH/CHROME_BIN 定位；本机不存在时明确跳过。CI 的全部矩阵项设置 `PANE_TEST_REQUIRE_CHROME=1`，三平台均须实际运行 Chrome，找不到 Chrome 必须失败。

## M3 插件界面自动化验收

`test/web-e2e-plugins.test.mjs` 与 `test/web-e2e-plugins-2.test.mjs`、`-3`、`-4` 在真实 Chrome 中加载 `test/fixtures/ui-plugin/`（`-2`、`-3` 的部分用例另加载 `ui-plugin-2/`），覆盖原型 README 的界面项。与 pi-agora 的浏览器联调测试在 pi-agora 仓库，CI 检出 pi-pane 的固定提交。

| 验收项 | 测试文件与断言 |
| --- | --- |
| 会话树与按需加载 | `web-e2e-plugins`：插件根节点按 `displayName` 分组，冷历史只显示“历史（N）”，展开后分页加载；插件节点挂在主会话下，主会话显示子节点数；`web-e2e-plugins-2`：另一个插件的节点挂在插件节点下，两个来源的冷节点合计为“历史（N）”并一次展开，数目未知时显示“历史”，父节点不存在的节点进入“未归属”；`web-e2e-plugins-3`：点击分组展开或折叠并打开适用的节点面板，点击资源打开适用的面板，空主会话显示“（空会话）”；`web-e2e-plugins-4`：插件节点挂在项目分组下，与主会话按 `sortKey` 统一排序；`web-logic`：修订号、tombstone、分页不覆盖较新的订阅内容、冷节点在父节点完整加载后才显示、reset 期间分页作废、跨来源历史数各自扣除、是否还有历史以分页游标为准、跨来源同级节点统一排序、快照打开列表的上限与补取父节点的移除、名额已满时删除节点腾出的名额在同一次扫描里用于补取、“未归属”与循环 |
| 侧栏由服务端推送驱动（#20、#21） | `web-e2e-conversation`：新会话首轮在跟随打开前结束，侧栏仍列出该会话；侧栏不再发起 `GET /api/sessions` 的并发刷新，#21 的请求排序状态随之删除；`sessions-catalog-scan`：逆序完成的目录扫描不回退已提交的目录（#18）；`plugins-main-tree`：会话节点按修改时间排序并附带 `paneSession` |
| 插件会话视图 | `web-e2e-plugins`：面包屑、节点面板、`send` 发送、停止后清出的文字回到输入框、`composer` 动作（插话）、接管后变为只读、工具卡片“打开 <节点>”链接、从面包屑回到主会话；`web-e2e-plugins-2`：等待中的任务声明了 `abort` 时提供停止，会话视图已报告结束时不提供，标题栏最多 3 个动作、其余在“⋯”菜单，输入框提交即清空、被拒或放弃后续表单时放回、等待期间新写的文字保留、切换节点后文字仍在、处理中留下“查询结果”且查到没有执行时放回，旧节点的重载挂起时新节点的事件照常显示；`web-e2e-plugins-3`：插件只通过树节点改 `send` 能力时输入框随之出现或消失，`pane_status` 的说明显示在状态栏，带 `confirm` 的动作使用应用内确认框；`web-e2e-plugins-4`：普通发送返回处理中时留下“查询结果”，同一幂等键查到被拒时文字放回，连续点击“查询结果”只发一次查询、提交后续表单后已执行的文字不放回，运行中撤销 `open` 时撤掉内容、补回后重新取快照并订阅，只声明 `abort` 的节点可以停止，只读条停止清出的文字在节点开放输入后出现在输入框里，首次快照在途时节点能力变化，快照返回后再取一次、输入框随之出现（确认浏览器已处理能力更新后才放行旧快照）；普通发送的四种结果顺序（处理中后查询断网再查到被拒、处理中后查到已受理、首发断网后查到被拒、首发断网后查到已受理）由同一操作结算，断网时原文放回且提示一致、只放回一次，已放回后查到已受理时提示删去；只撤销或补回 `subscribe` 时不重取快照，已展开的历史保留，补回后从当前游标续订；分支切换后迟到的旧分支历史页丢弃；打开插件节点后，主会话迟到的 `/new` 结果不把视图拉回主会话。`web-operation`：操作对象的结算规则 |
| resync 后取快照失败时重试 | `web-e2e-plugins`：插件连续两次取快照失败时显示“正在重试”，恢复后续订并收到新条目 |
| 动作与附带表单 | `web-e2e-plugins`：节点动作先取表单再带答案调用，必填校验，`origin` 来自浏览器；右键菜单列出节点动作；全局动作超时显示“结果未知”，“查询结果”沿用同一幂等键并得到最终结果 |
| 待处理区与持久表单 | `web-e2e-plugins`：总数角标、节点上的待处理标记与会话视图顶部的“处理”入口，“稍后处理”保留表单，提交后表单移除；两个标签页提交同一 revision，只有一个生效，另一个显示“已在别处处理”；`web-e2e-plugins-2`：断线期间被移除的表单在重连对齐后关闭弹窗；`web-e2e-plugins-3`：“查询结果”查到已处理时关闭弹窗，提交在途时关闭再打开只显示进度 |
| 用户在场确认 | `web-e2e-plugins`：提交触发确认，确认框显示倒计时，签名后插件接受；拒绝时插件返回失败并保留表单；`web-e2e-plugins-2`：另一个标签页重置设备密钥后签名仍生效，不能签名的浏览器直接以 `unsupported` 结束；`web-e2e-plugins-4`：确认框打开后另一个标签页重置密钥，确认框改显示新设备，插件收到的签名设备与之一致 |
| 横幅与通知 | `web-e2e-plugins`：按级别排序、同 id 更新保持位置、横幅动作；停用插件后 persistent 横幅保留并标为来源不可用、动作不可用，非 persistent 横幅和插件节点移除；同 id 通知只显示一次；`web-e2e-plugins-2`：超过 3 条横幅时只显示前 2 条和“另有 N 条横幅”，自动消失的通知最多 5 条，error 和 sticky 留到手动关闭 |
| 面板与布局 | `web-e2e-plugins`：侧栏面板角标随 `panelChanged` 更新，分组节点从右键菜单查看详情，未知面板类型显示“此面板需要更新的 pi-pane”；`web-e2e-plugins-2`：同名侧栏面板按来源分别更新角标，切换面板时新内容到达前不显示旧行，主会话显示 `sources` 含 `pane` 的节点面板，“详情”开关刷新后保持，窄屏为抽屉，侧栏宽度限制在 240–480px；`web-e2e-plugins-3`：没有横幅的插件停用后树和侧栏面板移除；`web-e2e-plugins-4`：断线期间面板内容变化（没有 `panelChanged`），重连后已打开的面板重新拉取，视口不超过 760px 时不显示拖动手柄、拖动不改保存的宽度 |

## M3 服务端自动化验收

验收仅使用 `test/fixtures/pane-plugin/` 的测试插件，不依赖 agora，也不包含浏览器界面验收（见上一节）。源码构建后可运行 `node --test --test-concurrency=1 test/plugins-*.test.mjs test/plugin-api-contract.test.mjs`；完整回归使用 `npm test`。

| 验收项 | 测试文件与断言 |
| --- | --- |
| 加载、版本与生命周期 | `plugins-runtime`：本地和 npm 定位符、包与实例双重版本范围、拒绝无效或重复 id、按配置顺序加载、激活失败、迟到 fence、私有目录、来源映射和幂等停用。 |
| 超时与异常隔离 | `plugins-runtime`、`plugins-operations`：同步抛错、异步拒绝、超时后迟到成功或失败；`plugins-http`：插件失败后真实主会话仍能发送并完成 RPC，同步订阅抛错不关闭共享 WebSocket 或主会话订阅。 |
| 按需树与重连 | `plugins-main-tree`：热节点及祖先、keyset 分页、epoch、修订号、删除与 2000 条重放边界；`plugin-api-contract`：插件树与流的快照切点、分页、reset；`plugins-host`：循环与无效能力；`plugins-http`：HTTP 快照和 WS 实时变化。 |
| 只读子会话、面板与渲染目录 | `plugins-http`：快照、流、面板与静态动作目录；`plugins-host`：会话图片提取、来源隔离、渲染器冲突按配置顺序选择、停用清理和退订后的迟到回调隔离。 |
| 动作、发送和表单幂等 | `plugins-operations`：共享键命名空间、内容冲突、并发 pending、返回 pending 后查询、真正迟到的最终结果、24 小时保留、容量限制与原样来源传递；`plugins-http`：浏览器同键重试，真实确认超时后以原键再次确认并完成。 |
| 持久表单与待处理区 | `plugins-operations`：排序、revision、权威对齐和并发事件、双标签页 claim、失败释放、cancel、过期由插件裁定；`plugins-http`：两标签页提交仅一次接受，`formRemoved` 包含来源，浏览器重连/tree reset 对齐、并发查询合并及异常隔离。 |
| 用户在场确认 | `plugins-presence`：凭证与连接绑定、origin 优先与广播回退、首个有效回应、设备不符的回应通知该连接并重发确认、连接断开、严格 JSON、超时/拒绝/停用关闭帧；`plugins-http`：真实 HTTP/WS 路由，其他连接不能结束挑战。 |
| 保活与主动关闭 | `plugins-holds`：仅列托管、读取历史、预登记 hold、多重 hold、空闲回收、关闭二次确认、旧 release 空操作、进程切换不迁移 hold；`plugins-host`：失败和停用释放插件资源。 |
| 横幅故障 | `plugins-banners`：原子写、重启、加载失败/停用保留 persistent 并标注不可用、来源恢复后 listBanners 与显式清除、配置移除二次确认/审计、I/O 失败保留旧状态；`plugins-http`：新连接重发、停用和重启、禁止删除仍配置来源。 |
| 通知、鉴权与关闭门禁 | `plugins-host`：通知按来源去重；`plugins-http`：所有读写使用浏览器凭证；`shutdown-ingress`：插件全路由统一拒绝关闭后的请求，multipart 解析前不插入无关异步路由；`backpressure`：同名不同来源的增量与 resync 隔离。 |
| 主会话增量目录 | `plugins-main-sync`：模型保持idle，增量条目提交后插件收到onChange，树取得新标题/消息数；无新条目不伪造树变更，目录和记录合并时保留较新活动时间。 |
| 主会话名称 | `plugins-main-title`：真实 pi 改名、扩展清空名称、重启后的只读打开及只读文件更新，同步反映在 mainSessions、树订阅和新快照，状态缓存不覆盖较新名称；所有名称入口统一处理空白和清空值，目录与打开前后覆盖长Unicode、无文本、真实占位字面量及文本块矩阵。 |
| 前端列表与插件目录一致 | `plugins-main-title`：同一矩阵在打开前后比较 `GET /api/sessions`、`MainSessionsApi.get` 与树节点的名称、标题（列表无文本时为空字符串，树回退为 id）、消息数、托管、状态、文件和目录；托管中改名与清空名称后列表与插件目录取值相同；`web-api`：登记会话的消息数取模型、修改时间取存储目录、空白名称视为未设置；`plugins-main-sync`：活动时间取存储目录与登记会话中较新的值。 |
| 公共 API 契约 | `plugin-api-contract`：导出类型与真实示例实现的 TypeScript 编译、原生 RPC 不外泄、当前与上一版本范围协商、畸形范围拒绝，以及测试插件完整能力与故障。 |

## 图片上限观测

M1 固定单张 4 MiB、每条最多 10 张且合计 12 MiB。Windows 本机一次完整测试使用合法 PNG tEXt 块补齐字节数，关闭 pi 自动缩放，以观察原始字节上限，不代表高分辨率照片或真实模型语义验证。

| 指标 | Windows 本机观测 |
| --- | ---: |
| 单张图片 | 4,194,304 B |
| 10 张图片合计 | 12,582,912 B |
| 最大会话 JSONL 行 | 16,778,301 B |
| 首次发送到 settled | 6,392 ms |
| 下一条纯文本发送 | 491 ms |
| 服务端采样最高 RSS | 316,055,552 B |
| 快照大小 | 9,109 B |
| get_entries | 初次全量 1 次，后续 since 增量 4 次 |

数据由 images 测试输出，不设墙钟性能硬断言。RSS 为测试进程采样值，包括同进程服务端和断言；不等于 pi 进程峰值。该上限的依据是 12 MiB 解码负载仍可通过 RPC、只读解析和引用快照，而不会突破 hostkit 默认 64 MiB JSONL 记录与输入队列上限；继续增加上限必须重跑实测。

## CI 与平台边界

矩阵为 ubuntu-latest auto/snapshot、macos-latest auto、windows-latest auto，每种组合分别安装 pi 1.5.0 和 1.6.0，共 8 个任务。Linux auto 启动用户 systemd 实例并要求 cgroup 支持。其他平台的停止保证以 StopReport.coverage 为准；snapshot_visible 只覆盖快照见过的进程，空 leftovers 不能证明整棵进程树没有残留。

停止判定同时核对覆盖范围、leftovers、快照完整性和写者身份。snapshot cleanup 中的发信号错误（如进程退出竞态中的 EPERM）只在最终 verify 独立确认通过、leftovers 为空时可接受；pane 自己的停止或报告复查无法确认时保留尚未释放的写锁。hostkit 恢复 failed/throw 时已经自行解锁，旧共享记录仍留存写者，其他宿主必须再次恢复检查。三种恢复拒绝路径都写入 recovery/ 持久标记并阻止自动重试。边界由 stop-report、writer-recovery 和 recovery-failure 测试固定；核查与解除隔离的完整步骤见 [architecture.md 的“会话写锁”](architecture.md#会话写锁)。

`fileKey` 直接使用 hostkit 的真实路径解析和比较键。首次落盘位于 realpath 的 ENOENT 与 lstat 之间时，由 hostkit 有界复核；pane 不捕获 ENOTDIR 或增加路径重试。core 用确定性的文件创建注入覆盖并发创建，并验证真实 ENOTDIR 只查询一次且原样拒绝。

Windows Job 模式在停止返回前独立确认已知成员退出；platform 测试在 StopReport 返回后立即核对已知后代身份，不设置额外退出观察窗口，也不补杀。真实 PID 复用、机器断电、快照盲窗和真实模型图片语义不在此次实测结论中。

Chrome 测试覆盖真实输入框、BroadcastChannel、流式重连、扩展对话框和生产设备密钥，具体断言见[自动化验收映射](#自动化验收映射)。插件宿主由 Node 测试覆盖（见 [M3 服务端自动化验收](#m3-服务端自动化验收)），插件界面由 Chrome 测试覆盖（见 [M3 插件界面自动化验收](#m3-插件界面自动化验收)），与 agora 的联调测试在 pi-agora 仓库。浏览器场景也未覆盖带图片的队列停止取回、图片拖动与剪切、全部数量/大小/模型能力边界及所有内置斜杠命令。HTML 导出的图片排列由 pi 决定。插件宿主的合作式超时不能隔离同步死循环或阻塞计算，也不能强制撤销插件后台已经受理的操作。
