# 开发与 M1 验收

## 环境与构建

需要 Node.js 24 及以上、npm、pi 1.5.0 和原生模块编译工具链。Windows 使用带 C++ 工作负载的 Visual Studio Build Tools；macOS 使用 Xcode Command Line Tools；Linux 使用 Python 3、gcc 和 make。

`npm ci` 安装固定 git 提交的 pi-hostkit，依赖的 prepare 脚本构建 TypeScript 和原生模块。本仓库固定到 `36f97ae683d5b0fb8ee495eecc04df7ab381f66a`，该版本为 Windows MSVC 设置 UTF-8 源码编码。没有 npm 发布包，也不要求本地链接其他仓库。

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 按 TypeScript project references 构建三个包 |
| `npm test` | 先构建，再用 node --test 顺序运行测试文件 |
| `node --test test/<文件>.test.mjs` | 运行单个测试文件；修改源码后先构建 |
| `npm start` | 启动只有 API 的 M1 服务端 |

`PI_PACKAGE` 可在测试时指定 pi 包目录。未设置时用 hostkit 的定位规则，先查官方安装目录，再查全局 npm。测试使用真实 pi 1.5.0 和本地假 provider，不访问模型服务。测试的 HOME、USERPROFILE、agent 目录、锁目录和会话文件位于临时现场；Chrome 使用独立的临时配置目录。设置 `KEEP_FIXTURES=1` 可保留现场。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `packages/plugin-api/src/index.ts` | 按 plugin-api.md 导出 pane v1 类型和协议版本协商；不实现插件宿主 |
| `packages/server/src/auth.ts` | 配对码、内存凭证、一次性 WebSocket ticket 和规范源校验 |
| `packages/server/src/server.ts` | 规范源 HTTP、WebSocket 首帧鉴权、订阅与背压、multipart 图片上传 |
| `packages/server/src/sessions.ts` | 会话登记、控制队列、增量取条目、切换路由、只读文件监视和回收 |
| `packages/server/src/driver.ts` | hostkit 写锁、启动门闩、RPC、就绪超时、进程停止和运行身份记录 |
| `packages/server/src/model.ts` | 活动分支、inFlight、同步快照切点、事件缓冲和游标 |
| `packages/server/src/store.ts` | 只读 v1/v2/v3 解析、pi 会话目录和列表、临时副本 fork |
| `packages/server/src/assets.ts` | 上传资源、草稿编码、历史图片引用、缓存与清理 |
| `packages/server/src/bridge.ts` | 独立的 Agent 级回连凭证和实例 fencing |
| `packages/server/src/trust.ts` | 启动前及进程内切换时的信任预判与询问 |
| `packages/bridge-extension/src/` | 会话替换和写锁回报、信任决定、就绪握手、图片顺序还原 |

不建立 `packages/web`。多题表单通道保留事件名称和 BridgeFormOutcome 类型，未启用时返回协议已有的 aborted；完整适配在 M2 联调。设备签名和插件运行时不在 M1。

## M1 HTTP 接口

所有请求校验 Host；带 Origin 时也校验 Origin。只有 `GET /api/instance`、`POST /api/auth/pair` 和可选的静态 Web 资源无需浏览器凭证。其他 `/api/*` 请求使用 `Authorization: Bearer <credential>`。

| 接口 | 内容 |
| --- | --- |
| `POST /api/auth/pair` | `{code}` 换取 `{credential, instanceId}` |
| `POST /api/auth/code`、`POST /api/auth/logout` | 已登录浏览器生成新码、吊销当前凭证 |
| `POST /api/ws-ticket` | 获取 30 秒一次性 ticket |
| `GET /api/sessions` | pi 会话存储列表 |
| `POST /api/sessions/open` | `{requestId,cwd,sessionFile?,fork?}`；只读打开，省略文件时预分配路径 |
| `GET /api/sessions/:id/snapshot` | 同步读取快照；附带 cwd、sessionFile、实际项目信任状态和 hold 原因 |
| `GET /api/sessions/:id/history?before=<id>&limit=50` | 按父链读取更早的聊天分支条目 |
| `POST /api/sessions/:id/control` | `{requestId,expectedEpoch,expectedRevision,command,draft?}`；串行控制和幂等 |
| `POST /api/sessions/:id/query` | `{type}`，只读查询模型、命令、统计等信息 |
| `POST /api/sessions/:id/ui` | `{requestId,expectedEpoch,id,response}` 回应 pi 对话框 |
| `GET /api/trust`、`POST /api/trust/:id` | 待答信任询问、`{requestId,decision?:{trusted,remember}}`；省略决定表示关闭询问 |
| `POST /api/assets` | multipart 的 image、thumb；X-Request-Id 作为幂等键 |
| `POST /api/assets/touch` | `{requestId,assetIds}` 延长资源期限 |
| `GET /api/assets/:hash`、`GET /api/assets/:hash/thumb`、`GET /api/blobs/:hash` | 带凭证按哈希取图 |

控制命令包括 prompt、steer、follow_up、stop、close、restart、set_model、set_thinking_level、compact、new_session、fork、clone、set_session_name。图片使用草稿节点，不接受命令中直接提供 base64 images。restart 只用于中断的会话，不允许借重启绕过最近修改警告或其他宿主写锁。上一个写者状态不明时，浏览器须经用户确认后才能在 restart 命令中附上 assumeNoWriter: true。

`/bridge/launch` 和 `/bridge/event` 是独立的进程级 Agent 通道，不能使用浏览器凭证；其 token 也不能调用 `/api/*`。

首次发送才启动 pi。服务端暂停输入直到 bridgeReady 和初次 RPC 状态/条目读取完成。启动就绪失败的响应在停止、身份复查和写锁处理完成后返回；停止失败时保留锁及运行记录，不因失败响应提前解锁。新会话的真实 pi id 在首次启动时确定；调用方使用响应快照或 pane_session_replaced 的 newRef 更新引用。

## WebSocket

连接 `/ws` 后，第一帧为 `{type:"auth",ticket,paneProtocol:[1,1]}`。五秒内没有有效首帧即关闭，拒绝后不再处理任何帧。鉴权后第一条消息为 `banners`，M1 的数组为空，并附上协商版本和 connectionId。

订阅：`{type:"subscribe",ref:{source:"pane",id},after:{epoch,seq}}`。取消订阅：`{type:"unsubscribe",ref}`。事件使用 plugin-api.md 的会话流形状。信任询问通过 `{type:"project_trust",request:{id,cwd,expiresAt}}` 推送；没有浏览器时返回 undecided，不把它等同于不信任。

每会话保留最近 2000 条事件，并用 32 MiB 字节限额限制缓冲；单条事件仍可保留。发送缓冲达到 1 MiB 时合并连续文本增量；达到 8 MiB 时以 resync 替换待发会话增量。非会话消息仍积压超过 1 MiB 时关闭慢连接。浏览器慢不会阻塞 RPC stdout。

## 自动化验收映射

| M1 验收项 | 测试文件与断言 |
| --- | --- |
| 1. 流式输出中 pi 被杀 | failures：保留 unfinishedPartials、interrupted、再次发送恢复 |
| 2. 流式输出中服务端被杀 | failures：真实子服务端被强杀；重启先按身份停止；旧凭证与 ticket 拒绝；重新配对与磁盘一致 |
| 3. 断电截断尾行 | failures：只读读取和临时副本 fork 后拉起；core：v1/v2/v3 迁移与源文件哈希 |
| 4. 流式输出断网重连 | reconnect：Node 和真实 headless Chrome 的游标连续、无重复、最终条目与磁盘一致 |
| 5. requestId 幂等 | trust：首次发送在信任询问期间重复提交返回 pending，完成后返回最终结果，内容冲突拒绝且 provider 只调用一次；failures：stop 幂等；core：保留期限与序列化 |
| 6. 并发控制 | failures：两个凭证同时发消息、发送与停止、模型与发送，落后一方 revisionChanged |
| 7. 重启后的旧凭证 | failures、auth、http：实例变化、旧凭证和 ticket 拒绝、吊销关闭旧连接 |
| 8. abort 不响应 | failures：真实假 provider 忽略 abort；platform：忽略取消的工具启动真实 shell 和脱离进程组后代，强制终止后独立核对身份、coverage 和 leftovers |
| 9. 扩展命令切换会话 | switches：替换事件、旧视图只读、旧状态拒绝、reload 后持锁；trust：跨目录 resume |
| 10. agora 与 pane 写锁互斥 | switches：独立进程用 hostkit 以 pi-agora 身份持锁，pane 只读且拒绝发送 |
| 11. pane-bridge 未就绪 | bridge-failures：无效/抢先兑换 ticket、服务端拒绝、无就绪、新实例 reload/new 不就绪或断开、定时器切换窗口、输入审计、按身份清理和下一次取锁 |
| 鉴权边界 | auth、http：Host/Origin、错误与过期配对码、ticket 一次性与过期、首帧、无 Cookie、安全响应头 |
| 图片与快照 | images：4 MiB 单图、10 图 12 MiB 实测、MIME 和超限拒绝、get_entries since、引用无 base64、缓存缺失重建、停止时取回两条带图片的草稿；core：全部大小边界、顺序与清理 |
| 项目信任 | trust：启动前询问、记住选择、保存 false、跨项目切换时及时询问、等待用户超过默认十秒仍保持写锁、无连接和超时返回 undecided |
| 列表与回收边界 | store：环境/项目/全局目录优先级、默认项目分目录、已知项目在重启后保留；backpressure：慢连接合并与 resync，不阻塞其他连接 |

测试文件路径均为 `test/<名称>.test.mjs`。三平台都运行服务端测试，不用模拟进程替代真实 pi。Chrome 路径由本机安装或 CHROME_PATH/CHROME_BIN 定位；本机不存在时明确跳过。CI 的 Linux auto 任务设置 PANE_TEST_REQUIRE_CHROME=1，找不到 Chrome 必须失败。

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

矩阵为 ubuntu-latest auto/snapshot、macos-latest auto、windows-latest auto，安装 pi 1.5.0。Linux auto 启动用户 systemd 实例并要求 cgroup 支持。其他平台的停止保证以 StopReport.coverage 为准；snapshot_visible 只覆盖快照见过的进程，空 leftovers 不能证明整棵进程树没有残留。

停止判定同时核对覆盖范围、leftovers、快照完整性和写者身份。snapshot cleanup 中的发信号错误（如进程退出竞态中的 EPERM）只在最终 verify 独立确认通过、leftovers 为空时可接受；快照枚举失败、最终复查失败和身份不明仍保留写锁。对应边界由 stop-report 单元测试固定。

hostkit #5 尚未关闭：Windows Job 已清空后，独立进程表可能短暂仍见到已退出的后代。测试最多等待两秒确认可见性，不补杀。真实 PID 复用、机器断电、快照盲窗和真实模型图片语义不在此次实测结论中。

M1 没有前端，未验证真实输入框、BroadcastChannel、浏览器设备密钥和持久表单；这些属于 M2/M3。HTML 导出的图片排列仍由 pi 决定。插件接口类型完整导出不表示插件宿主已实现。
