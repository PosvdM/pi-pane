# 路线图

> 状态：M1 服务端核心已实现，M2–M4 尚未实现。自动化验收映射与平台限制见 [development.md](development.md)。工程量列保留阶段规划估算。

## P0 验证项

P0 验证设计依赖的 pi 行为、浏览器行为和平台行为。目标 pi 版本为 1.5.x，实验在 macOS（pi 1.5.0）上进行。**浏览器范围：只支持 Chrome；其他浏览器（包括 Edge 等 Chromium 内核的）不测、不承诺。** Windows、Linux 待测项移入公开发布前跨平台测试。各实验组详细结论与依据见对应链接。

| # | 状态 | 验证内容 | 通过标准 | 结论与后续 | 影响的文档 |
| --- | --- | --- | --- | --- | --- |
| 1 | - [ ] | 图片顺序还原 | [image-placeholders.md](image-placeholders.md#p0-验证清单) 的全部场景通过 | **不通过**（pane 部分通过，`export_html` 导出不符）。pane 的图文交错编码与还原原型在 RPC、会话条目、磁盘和假 provider 输入中通过；真实浏览器交互和真实模型图片语义未测。`export_html` 的用户消息渲染不保留交错顺序（所有图片排在文字前），导出顺序以 pi 为准。单张图片大小上限实测移入 P1。依据见 [B 组 RESULTS.md](../experiments/p0/b-bridge/RESULTS.md)。 | image-placeholders.md |
| 2 | - [x] | RPC 托管：拉起、`get_state`、`get_entries`（含 `since` 和 `leafId`）、`prompt`/`steer`/`follow_up`/`abort`/`clear_queue`、事件流、`agent_settled`；用户自己的扩展在 RPC 模式下正常加载 | 能完成一次完整对话并恢复；`get_entries` 返回压缩前的历史 | **通过**。macOS 实测通过，Windows/Linux 待测移入公开发布前跨平台测试。依据见 [A 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/a-rpc/RESULTS.md)。 | architecture.md |
| 3 | - [ ] | 快照切点与重连：按 stdout 顺序维护会话模型；`message_end` 之后用 `get_entries since` 取到对应条目；流式输出中断开浏览器、重启 pi-pane 服务端后重连 | 浏览器显示的内容与会话文件一致，没有重复或缺失的消息和块；epoch 变化时必定 `resync` | **部分通过**。内存模型与切点重放通过；真实浏览器重连待验证（移入 M1/M2）；大图导致重连变慢，改用 `since` 增量拉取条目、快照中只放图片引用按需取图（见 [architecture.md](architecture.md#快照与切点)）；Windows/Linux 待测。依据见 [A 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/a-rpc/RESULTS.md)。 | architecture.md、plugin-api.md |
| 4 | - [x] | 停止：运行中排队 steer 和 follow-up 后点“停止”；工具卡住不响应 `abort` | `clear_queue` 返回的文本回到输入框，之后不再执行；`abort` 超时后能强制结束并恢复 | **通过**（macOS）。主停止流程（先 `clear_queue` 再 `abort`）与超时强制终止实测通过，排队文字取回；原型按发送前保存的草稿映射恢复排队图片；真实输入框交互未测。删去只发 abort 的操作；Windows/Linux 待测移入公开发布前跨平台测试。依据见 [A 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/a-rpc/RESULTS.md)、[B 组 RESULTS.md](../experiments/p0/b-bridge/RESULTS.md)。 | architecture.md |
| 5 | - [x] | 扩展 UI 适配：select、confirm、input、editor 的请求与回应，带 `timeout` 时的行为 | 浏览器回应后扩展收到正确的值；超时行为与 pi 文档一致 | **通过**。四类对话框通过，Windows/Linux 待测。依据见 [A 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/a-rpc/RESULTS.md)。 | plugin-api.md |
| 6 | - [x] | 项目信任（主方案为拉起前在浏览器询问）：`hasTrustRequiringProjectResources` 和 `ProjectTrustStore` 的判断与 pi 实际一致（含父目录的决定）；pane-bridge 的 `project_trust` 处理器按启动配置对匹配目录返回 `{ trusted, remember }`，`remember: true` 写入 `trust.json`；更早加载的扩展先返回 yes/no 时 pane 的决定不生效；返回 `"undecided"` 时，`trust.json` 已有 yes、其他处理器返回 yes、`defaultProjectTrust = "always"` 三种情况都会加载资源；进程内切换到新目录时经回连询问；`ctx.isProjectTrusted()` 的值与实际加载情况一致 | 会话视图显示的“已加载/未加载”在所有组合下都与实际一致 | **通过**（macOS 预判、处理器及 `isProjectTrusted()` 一致；真实浏览器询问界面未测移入 M1；无资源但 `trust.json` 为 false 按不信任处理；切换会话阻塞最长 60 秒需预判及时弹窗）。依据见 [G 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/g-store/RESULTS.md)。 | architecture.md |
| 7 | - [ ] | 会话切换与写锁时机（写锁本身的验证见第 10 项）：以预分配路径 `--session` 新建；`SessionManager.forkFrom()` 不改动源文件；RPC 和扩展命令各发起一次 new、resume、fork、clone；`session_before_switch` 返回取消时切换不发生；模拟④取锁失败 | 新会话写在预分配路径；pane-bridge 收到的事件和 `targetSessionFile` 与实际一致；取锁失败时不再有输入发往该进程，进程在新会话 `session_start` 后被停止 | **部分通过**。预分配路径、切换与取消通过；`forkFrom()` 会改动源文件（补换行且截断行留文件中间），设计改为只读查看 fork 时先复制到临时目录再调用 `forkFrom()`，并把新文件的 `parentSession` 修正为原始源文件路径（见 [architecture.md](architecture.md#拉起)）；Windows/Linux 待测。依据见 [A 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/a-rpc/RESULTS.md)。 | architecture.md |
| 8 | - [x] | 只读解析：v1、v2、v3 格式的会话文件；最后一行被截断的文件 | 解析出的活动分支与 pi `get_entries` + 叶子计算的结果一致；解析前后文件的哈希不变 | **通过**（macOS 重新打开语义一致；v1 id 动态生成不可作持久键、截断行保留为中间行已作为设计约束；Windows/Linux 待测）。依据见 [G 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/g-store/RESULTS.md)。 | architecture.md |
| 9 | - [x] | pane-bridge 通道：`pi.events` 在同一进程内的扩展间收发；先于 pane-bridge 加载的扩展能否读到 ticket 环境变量；删除后 `bash` 子进程是否还能看到；连续多次 new、resume、fork、clone 和 reload 后，新实例经 `globalThis` 复用连接并发出 `bridgeReady`，旧实例的请求被拒绝，就绪前没有输入发往 pi；评估全走 stdio 的备选 | 表单往返成功；每次替换后图片还原、表单、写锁请求都由新实例处理；记录 ticket 和 `globalThis` 上连接对象的实际可见范围（同进程其他扩展能否读到并使用），决定是否改用备选 | **通过**。实例 fencing、凭证读取、输入门禁均通过；宿主和 bridge 必须对重复 `session_start` 做幂等处理（见 [architecture.md](architecture.md#会话替换后的重绑定)）；启动阶段退出码 1 当成启动故障处理。依据见 [B 组 RESULTS.md](../experiments/p0/b-bridge/RESULTS.md)。 | architecture.md、plugin-api.md |
| 10 | - [ ] | hostkit：进程树终止、单实例锁、会话写锁在三个平台上的行为（与 pi-agora 共用验证，见 [pi-hostkit 设计文档的“验证状态”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#验证状态)） | 关闭会话后没有遗留进程；pi-pane 与 pi-agora 不能同时托管同一会话文件 | **部分通过**。P0 在 macOS 原型上定下原生形态（N-API 预编译模块），并发现快照的两种漏杀盲窗，因此 Linux 有 cgroup v2 时默认开启，macOS 收窄承诺并以 `StopReport.coverage` 标明覆盖范围。pi-hostkit 0.1 已实现，CI 在 Windows、macOS、Linux（cgroup 与快照两种模式）上自动测试通过：锁的争抢与强杀后释放、跨宿主恢复与 fail closed、启动门闩、`bash` 工具及脱离进程组的后台进程的清理、abort 超时后仍完成停止、身份不符时不发信号。仍未验证：真实 PID 复用与机器重启、身份检查与发信号之间的竞态、macOS 快照盲窗（未消除）、网络文件系统的拒绝、Linux 没有用户 systemd 时自动退回快照模式；bash 启动上报 pgid 仍为 P1 调研项。依据见 [E 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/e-hostkit/RESULTS.md)。 | architecture.md |
| 11 | - [x] | 鉴权：配对码换凭证；`Host` 为 `localhost` 或其他域名时被拒；WebSocket 首帧 ticket；新标签页经 `BroadcastChannel` 取得凭证；响应中没有 `Set-Cookie` | 全部按设计；同机其他 `127.0.0.1` 端口的页面无法调用 pi-pane 接口 | **通过**（macOS/Chrome 原型通过，首帧终态与空闲过期修复已确认；只支持 Chrome；Windows/Linux 待测）。依据见 [F 组 RESULTS.md](../experiments/p0/f-browser/RESULTS.md)。 | architecture.md |
| 12 | - [x] | 设备密钥与签名：Chrome 普通窗口和无痕上下文中生成不可导出的 ECDSA P-256 密钥并存入 IndexedDB；签名在 Node.js 中按 RFC 8785 规范 JSON 和 `dsaEncoding: "ieee-p1363"` 验证通过 | Chrome 能生成、保存设备密钥并签名验签；不支持的环境给出 `unsupported`。其他浏览器不测、不承诺 | **通过**（macOS/Chrome 通过；范围限定为只支持 Chrome；Windows/Linux 待测）。依据见 [F 组 RESULTS.md](../experiments/p0/f-browser/RESULTS.md)。 | plugin-api.md |
| 13 | - [x] | 斜杠命令：`get_commands` 的内容；运行中用 `prompt` 发扩展命令 | 补全列表正确；扩展命令立即执行 | **通过**。命令补全与执行通过，Windows/Linux 待测。依据见 [A 组 RESULTS.md](https://github.com/PosvdM/pi-agora/blob/main/experiments/p0/a-rpc/RESULTS.md)。 | architecture.md |
| 14 | - [x] | 前端打包体积 | Vite + Preact 骨架加上 Markdown 渲染、代码高亮和 CSP 后在 300 KiB（gzip）以内 | **通过**。gzip 后 97.9 KiB，低于 300 KiB 预算。依据见 [F 组 RESULTS.md](../experiments/p0/f-browser/RESULTS.md)。 | architecture.md |

P0 约 3–4 人日（hostkit 的验证与 pi-agora 共担，不计在内）。图片顺序还原和快照切点优先：它们决定 pane-bridge 和会话模型的形态。

## MVP 切分

pi-pane 和 pi-agora 的 MVP 按同样的三个切片推进，两仓的 roadmap 使用同一套切片名称：

| 切片 | 内容 | pi-pane 的部分 |
| --- | --- | --- |
| 1. agora 任务核心 | daemon、spawn/stop/result、持久化、可靠通知、重启恢复、提问、存档、CLI；在 pi 终端和 CLI 中验收 | 不涉及 |
| 2. pane 聊天核心 + 最小任务插件 | pi-pane 本身，以及 agora pane 插件的最小版本 | 见下方 M1–M3 |
| 3. board 与会议 | 先两席 + 只在最后出纪要的书记，验证 fencing、预算、故障恢复；再加中途书记、僵局启发式 | M4：会议进度（`steps` 面板）、board（`timeline` 面板）、会议相关动作和表单的联调 |

规则：

- 每个切片先通过下方“必须测试的故障”中对应的项，再扩大功能。
- **并行**：pi-hostkit 是两仓共同的前置依赖，0.1 已实现（[PosvdM/pi-hostkit](https://github.com/PosvdM/pi-hostkit)）。切片 1 与 pi-pane 的 P0、M1、M2 可以并行；M3 的联调要等切片 1 验收通过；切片 3 在切片 2 验收通过后开始。
- 工期在 P0 验证后重估。

## pi-pane 的阶段

| 阶段 | 内容 | 人日 |
| --- | --- | --- |
| P0 | 上表验证项（原型在 macOS 上实测，部分通过项移入后续阶段） | 已完成（3–4） |
| M1 服务端核心 | 会话托管与 RPC 驱动、会话模型与快照切点（真实浏览器重连验证、`since` 增量条目与图片引用分离、单张图片大小上限实测）、游标与重连、控制队列与停止、写锁与只读解析（只读查看 fork 临时副本与 `parentSession` 修正）、会话切换（`session_start` 幂等）、项目信任（预判与及时弹窗）、鉴权（配对码、凭证、WebSocket ticket、Host 检查，只支持 Chrome）、附件与图片缓存 | 6–8 |
| M2 前端核心 | 聊天视图（三种投影中的聊天视图、压缩标记、自定义消息卡片）、输入框与图片占位符、斜杠命令与补全、扩展 UI 对话框、模型与 thinking、渲染安全与 CSP、设备密钥（仅 Chrome） | 5–7 |
| M3 插件接口 + 最小任务插件联调 | 插件宿主、按需加载的树、会话视图（只读子会话与实时流）、面板、动作（`resolveForm`、幂等）、持久表单与待处理区、通知、`userPresence`、hold；与 agora 插件联调：子会话树、只读查看、停止与返工、答复提问 | 3–5 |
| M4 会议显示（切片 3） | `steps`、`timeline` 面板，会议动作和表单的联调 | 1–2 |
| 合计 | | 18–26 |

公开发布前的加固（安装体验、安全审查、文档补全）另算。

### MVP 范围

- 服务端：会话托管（每个主会话一个 pi RPC 子进程）、会话列表（尊重 `sessionDir`）、只读查看、写锁、会话切换、项目信任、停止与控制队列、鉴权、WebSocket 事件分发与重连、慢客户端处理、空闲回收与 hold、附件存储。
- 前端：会话列表与树、聊天视图、输入框（发送、steer、follow-up、停止、图片占位符、斜杠命令）、模型与 thinking 选择、用量与费用、扩展 UI 对话框、待处理区、用户在场确认、设备密钥管理。
- pane-bridge：图片顺序还原、多题表单通道、会话切换回报、项目信任决定、会话替换后的重绑定。
- 插件接口：按 [plugin-api.md](plugin-api.md) 的全部内容。

### 必须测试的故障

- 流式输出中杀掉 pi 进程：会话标为 `interrupted`，浏览器显示中断时的内容，再次发送能恢复。
- 流式输出中杀掉 pi-pane 服务端后重启：旧的 pi 进程按进程身份被停止并确认退出后，才重新打开同一会话；浏览器重新配对后内容与会话文件一致。
- 模拟断电：会话文件最后一行不完整时，只读解析和重新拉起都不出错。
- 浏览器在流式输出中断网再恢复：不重复、不遗漏。
- 重复请求：同一 `requestId` 的发送、同一 `idempotencyKey` 的动作只执行一次；处理中重复调用得到 `pending`，结束后再调用得到最终结果；同一 key 配不同内容被拒绝；两个标签页同时提交同一持久表单，只有一个生效。
- 并发控制：两个标签页同时发送、一个发送一个停止、一个切换模型一个发送：落后的一方收到 `revisionChanged`，重新确认后才执行。
- 服务端重启后旧标签页：不会把已失效的凭证通过 `BroadcastChannel` 交给新标签页，都回到配对页。
- 停止时 pi 不响应 `abort`：超时后强制结束，没有遗留进程。
- 扩展命令在运行中切换会话：旧标签页收到切换提示，不会把消息发进新会话。
- pi-agora 托管着某个会话时，在 pi-pane 里打开它：只读打开，不会同时写入。
- 插件调用超时、抛出异常：主会话不受影响。
- 横幅：插件设置 persistent 和非 persistent 横幅后重启 pi-pane、让插件加载失败、停用插件：persistent 横幅一直显示并标注“来源插件不可用”，非 persistent 横幅按规则消失；插件恢复后能用 `listBanners` 看到并清除。把插件从配置中移除后，设置页能在二次确认后移除它的遗留横幅并写入日志；插件只是停用或加载失败时设置页不提供移除。
- pane-bridge 未就绪：首次拉起时兑换失败、ticket 被另一扩展抢先兑换、服务端拒绝回连，以及 reload 和连续会话切换过程中新实例不发 `bridgeReady` 或断开回连：就绪超时后进程被按 hostkit 流程终止，会话标为 `interrupted`、只读显示并提供“重启”；超时前没有任何输入发往该进程；在超时窗口内让扩展用定时器发起 new、resume、fork，检查共享锁记录，确认不存在存活的未加锁写者，下一次取锁时遗留记录被清理。

## 明确不做

- 终端、Git 面板、文件编辑器、canvas、设备中心、审批规则引擎、定时任务。
- 子代理、会议等业务逻辑（由插件提供）。
- 第三方插件的前端代码、插件市场。
- 第二种会话驱动（进程内 SDK）。
- 公网访问、多用户、与外部写者同时写同一会话。
- 在界面里导航到会话的任意分支。

## 以后可能做

- 按 loopback 连接查出请求对端的进程，作为审计信息。
- 插件的 worker 隔离。

## 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| `message_end` 替换的时机或范围与预期不符 | 图片顺序无法还原 | P0 第一项验证表明 pane 的图文交错编码与还原原型在 RPC、会话条目、磁盘和假 provider 输入中通过（真实浏览器交互和真实模型图片语义未测），`export_html` 导出时的顺序以 pi 为准（所有图片在文字前）；单张图片大小上限放到 P1 实测再定 |
| pi 升级改变 RPC、会话格式或扩展事件 | 托管、只读解析和对话框失效 | 限定 pi 版本为 1.5.x；关键路径写集成测试；升级支持的版本前重跑 P0 |
| 终端里的 pi 与 pi-pane 同时写同一会话 | 会话文件被两个进程写入 | 托管写者之间用会话写锁；对终端 pi 只能按修改时间提示，提供只读打开和 fork；无法完全避免 |
| 用户的信任决定被更早加载的扩展、已保存的决定或 `defaultProjectTrust` 覆盖 | 项目资源是否加载与用户的选择不一致 | 按 pane-bridge 报告的 `ctx.isProjectTrusted()` 显示实际结果并注明原因；P0 第 6 项 |
| 会话替换后 pane-bridge 没有重新就绪 | 图片顺序、表单、写锁请求失效 | 进程级保存连接、`bridgeReady` 之前不恢复输入；P0 第 9 项 |
| 用户扩展在 RPC 模式下行为不同 | 部分扩展功能不可用 | 依赖 pi 的 RPC 降级；在文档中列出已知不支持的方法 |
| 插件同步阻塞事件循环 | 整个服务端卡住 | 文档要求插件不做同步重计算；必要时引入 worker 隔离 |
| 浏览器数据被清除或换端口 | 设备密钥丢失，需要重新批准设备 | 设置页和文档写明；由插件后台服务的配对流程处理 |
| pane 协议升级后插件未跟上 | 插件被拒绝加载或显示错误 | 协议只在本仓库 plugin-api.md 定义；版本协商且至少兼容上一版；`@pi-pane/plugin-api` 契约测试 |
| 前端体积随功能增长 | 违背轻量目标 | 设打包体积预算，CI 检查 |
