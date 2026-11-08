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
| `packages/server/src/writer-recovery.ts`、`stop-report.ts` | 首次拉起与目标切换的共同恢复检查、不完整报告隔离和停止报告判定 |
| `packages/server/src/hostkit-cleanup.ts` | hostkit 拒绝中的清理事实识别及同步、异步调用观察 |
| `packages/server/src/inflight.ts` | 实例共用的关闭门禁、在途操作与资源 owner 登记、完整排空及终止释放检查 |
| `packages/server/src/pi-rpc.ts` | pi 主会话的原生 RPC 信封；不属于通用插件契约 |
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
| `POST /api/sessions/open` | `{requestId,cwd,sessionFile?,fork?}`；只读打开，省略文件时预分配路径；并发同路径复用已登记记录，服务关闭时返回 503 serverStopping |
| `GET /api/sessions/:id/snapshot` | 同步读取快照；附带 cwd、sessionFile、实际项目信任状态和 hold 原因 |
| `GET /api/sessions/:id/history?before=<id>&limit=50` | 按父链读取更早的聊天分支条目 |
| `POST /api/sessions/:id/control` | `{requestId,expectedEpoch,expectedRevision,command,draft?}`；普通控制串行、停止优先和幂等 |
| `POST /api/sessions/:id/query` | `{type}`，只读查询模型、命令、统计等信息 |
| `POST /api/sessions/:id/ui` | `{requestId,expectedEpoch,id,response}` 回应 pi 对话框 |
| `GET /api/trust`、`POST /api/trust/:id` | 待答信任询问、`{requestId,decision?:{trusted,remember}}`；省略决定表示关闭询问 |
| `POST /api/assets` | multipart 的 image、thumb；X-Request-Id 作为幂等键 |
| `POST /api/assets/touch` | `{requestId,assetIds}` 延长资源期限 |
| `GET /api/assets/:hash`、`GET /api/assets/:hash/thumb`、`GET /api/blobs/:hash` | 带凭证按哈希取图 |

控制命令包括 prompt、steer、follow_up、stop、close、restart、set_model、set_thinking_level、compact、new_session、fork、clone、set_session_name。图片使用草稿节点，不接受命令中直接提供 base64 images。restart 只用于中断的会话，不允许借重启绕过最近修改警告或其他宿主写锁。上一个写者状态不明时，浏览器须经用户确认后才能在 restart 命令中附上 assumeNoWriter: true。

`/bridge/launch` 和 `/bridge/event` 是独立的进程级 Agent 通道，不能使用浏览器凭证；其 token 也不能调用 `/api/*`。

控制命令的 HTTP 等待默认 30 秒，超时返回 pending；底层 RPC 继续跟踪实际响应，同一 requestId 不会因等待到期而固定成失败。传输中断导致无法确认结果时返回 rpcResultUnknown，客户端须读取状态核对。stop、close 和 restart 不等待挂起的普通控制操作，检查前置条件后抢占；未执行项返回 controlPreempted，活动 RPC 按真实响应或传输关闭记录结果。排队及 pending 超限返回 429，具体额度与停止通道见 [architecture.md 的“停止与控制队列”](architecture.md#停止与控制队列)。命令受理只递增 revision，生成阶段按实际事件更新；handled 输入、预检拒绝和手动压缩失败不会使空闲会话持续显示 running。已确认的控制响应不受后续状态查询或锁清理故障影响。

首次发送才启动 pi。服务端暂停输入直到 bridgeReady 和初次 RPC 状态/条目读取完成。启动就绪失败的响应在停止、身份复查和写锁处理完成后返回；停止失败时保留锁及运行记录，不因失败响应提前解锁。新会话的真实 pi id 在首次启动时确定；调用方使用响应快照或 pane_session_replaced 的 newRef 更新引用。

服务关闭先封闭实例共用的 Inflight 门禁，新的打开、控制、RPC、UI 回应及 bridge 事件返回 serverStopping。关闭等待已受理 open 的文件读取和锁探测，并取消、等待全部在途启动，包括首次发送、restart 的信任询问、目录读取、取锁、spawn 和就绪等待；取消后的取锁不能继续 spawn。已创建的 handle 在首次持久化前交付。关闭还排空 resume 目标取锁及 bridge 重连初始化，即使退出回调已经摘下 handle，也等待其迟到锁释放；统一屏障还等待已退出写者尚未结束的 RPC 和 bridge 身份核查；全部在途操作结束后才汇总清理错误、关闭 HTTP 和释放实例锁。清理未确认时保留实例锁并返回失败，并发关闭调用等待同一结果。停止失败由 handle 缓存，退出回调摘下 handle 或其他写者成功重启不能清除失败；独立登记须等停止及排空均成功才删除。本实例新产生的恢复隔离和创建 handle 前的清理失败由实例登记保存，关闭时汇总；启动前已有的隔离标记保留为 `Sessions.recoveryDiagnostics`，CLI 输出诊断，正常关闭照常成功。具体生命周期及入口对照表见 [architecture.md 的“关闭与回收”](architecture.md#关闭与回收)和[“统一关闭屏障”](architecture.md#统一关闭屏障)。

hostkit 调用的拒绝若通过 `cause` 或 `errors` 携带停止报告、清理失败消息或多错误聚合，调用边界立即通知本实例，后续 release、stop 或 drain 成功不能清除登记。完整报告随拒绝交付也保留，因为拒绝可能来自独立身份查询失败。固定依赖的 `spawnManaged` 启动回收没有专用错误码，多错误聚合按清理未确认保守处理；判定器仅用于 hostkit 调用边界，并防止循环上下文导致无限遍历。普通未启动错误、参数错误及业务拒绝不单独登记。取得 handle 前的 release、实际停止和迟到目标清理的拒绝仍全部保留。锁探测会短暂持有原生锁，其 finally 释放失败没有独立标识，因此 probe 的所有拒绝均保守登记。

## WebSocket

连接 `/ws` 后，第一帧为 `{type:"auth",ticket,paneProtocol:[1,1]}`。五秒内没有有效首帧即关闭，拒绝后不再处理任何帧。鉴权后第一条消息为 `banners`，M1 的数组为空，并附上协商版本和 connectionId。

订阅：`{type:"subscribe",ref:{source:"pane",id},after:{epoch,seq}}`。取消订阅：`{type:"unsubscribe",ref}`。事件使用 plugin-api.md 的会话流形状。信任询问通过 `{type:"project_trust",request:{id,cwd,expiresAt}}` 推送；没有浏览器时返回 undecided，不把它等同于不信任。

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
| 恢复报告隔离 | writer-recovery：真实存活旧 pi 被按身份恢复后，在真实报告上注入 snapshot 不完整；首次拉起和目标切换均拒绝该报告，保留旧身份、stopping 锁和诊断；recovery-failure：在真实停止报告后注入故障，执行 hostkit 原有 failed/throw 解锁分支，检查旧共享记录、存档、重启隔离，另一宿主未恢复不能 spawnWriter 且必须再查旧写者 |
| handled 与拒绝 | input-state：无模型扩展命令、handled 输入、prompt 预检拒绝保持 idle；compaction-state：空会话 compact 拒绝、扩展取消、provider 失败均由手动结束事件恢复 idle，可按空闲规则回收；自动压缩仍等待 settled |
| 协议边界 | core、http：空、单元素、多元素、非整数及非数组版本范围均拒绝，首帧带实际协商版本；通用类型声明不导出 pi 原生信封，任一原生信封重新导出的负向断言必须失败 |
| 鉴权边界 | auth、http：Host/Origin、错误与过期配对码、ticket 一次性与过期、首帧、无 Cookie、安全响应头 |
| 图片与快照 | images：4 MiB 单图、10 图 12 MiB 实测、MIME 和超限拒绝、get_entries since、引用无 base64、缓存缺失重建、停止时取回两条带图片的草稿；core：全部大小边界、顺序与清理 |
| 项目信任 | trust：启动前询问、记住选择、保存 false、跨项目切换时及时询问、等待用户超过默认十秒仍保持写锁、无连接和超时返回 undecided |
| 列表与回收边界 | store：环境/项目/全局目录优先级、默认项目分目录、已知项目在重启后保留；backpressure：慢连接合并与 resync，不阻塞其他连接 |

测试的 RPC 输入审计通过观察已有 data 事件记录命令，不添加 stdin 的 data listener，也不调用 resume/read，避免在 pi RPC reader 注册前开启 flowing 并吞掉初始化输入。fixture-audit 验证 reader 注册前缓冲保留、JSONL/UTF-8 分块及字节原样转交；bridge-broker 验证最新实例 fencing 和就绪幂等；hostkit-cleanup 验证嵌套报告、无报告清理错误、多错误聚合、循环上下文、普通拒绝及观察器的原样传播。stop-switch-races 的初始化拒绝会关闭已经启动的真实写者、HTTP 和实例锁；迟到启动 gate 同时交付就绪成功与失败，避免初始化异常遗留监听服务或让测试永远等待 entered。

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

停止判定同时核对覆盖范围、leftovers、快照完整性和写者身份。snapshot cleanup 中的发信号错误（如进程退出竞态中的 EPERM）只在最终 verify 独立确认通过、leftovers 为空时可接受；pane 自己的停止或报告复查无法确认时保留尚未释放的写锁。hostkit 恢复 failed/throw 时已经自行解锁，旧共享记录仍留存写者，其他宿主必须再次恢复检查。三种恢复拒绝路径都写入 recovery/ 持久标记并阻止自动重试。边界由 stop-report、writer-recovery 和 recovery-failure 测试固定；核查与解除隔离的完整步骤见 [architecture.md 的“会话写锁”](architecture.md#会话写锁)。

固定的 hostkit 版本存在 [#6 路径探测竞态](https://github.com/PosvdM/pi-hostkit/issues/6)：首次落盘可能位于 realpath 的 ENOENT 与 lstat 之间。pane 的 fileKey 只在 ENOTDIR 时立即用 native realpath 复核一次，复核仍失败就拒绝；没有 sleep 或一般错误重试。core 用确定性的文件创建注入覆盖成功复核及持续 ENOTDIR。依赖升级到修复版本后移除该复核。

hostkit #5 尚未关闭：Windows Job 已清空后，独立进程表可能短暂仍见到已退出的后代。测试最多等待两秒确认可见性，不补杀。真实 PID 复用、机器断电、快照盲窗和真实模型图片语义不在此次实测结论中。

M1 没有前端，未验证真实输入框、BroadcastChannel、浏览器设备密钥和持久表单；这些属于 M2/M3。HTML 导出的图片排列仍由 pi 决定。插件接口类型完整导出不表示插件宿主已实现。
