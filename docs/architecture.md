# 总体架构

> 状态：M1 服务端核心已实现。Web 界面与设备签名在 M2、插件宿主在 M3 实现。本文描述完整架构；M1 的可用接口与验收映射见 [development.md](development.md)。

pi-pane 是 pi 的轻量 Web 界面。服务端为每个打开的主会话拉起一个 `pi --mode rpc` 子进程，把聊天流转发给浏览器；子代理、会议等功能由插件通过通用接口显示，pi-pane 本身不实现这些业务。

插件接口和 pane 协议以 [plugin-api.md](plugin-api.md) 为准，图片占位符见 [image-placeholders.md](image-placeholders.md)。pi-pane 不依赖 pi-agora；agora 如何映射到插件接口见 pi-agora 仓库的 `docs/integration.md`。

## 设计约束

- **基座是 pi**（`@earendil-works/pi-coding-agent` 1.5.x），不重写 Agent 运行时、Provider、压缩。
- **每个主会话一个 `pi --mode rpc` 子进程**。一个会话的工具卡死或崩溃只影响它自己。只实现这一种会话驱动，保留 `SessionDriver` 接口。
- **界面只是界面**：pi-pane 不认识“子代理”“会议”，只提供会话树、面板、动作、表单、通知、用户在场确认这些通用接口。
- **轻量**：前端打包目标 300 KiB（gzip，不含图片资源）以内；不做终端、Git、文件编辑器等功能（见“明确不做”）。
- **只在本机使用**：只监听 `127.0.0.1`。
- **三平台**：Windows、macOS、Linux 同时支持。和平台有关的部分放在共享包 `pi-hostkit` 里（见“平台支持”）。

## pi 版本与定位

- 支持的 pi 版本：`>=1.5.0 <1.6.0`。本文中“依据”指向的文件以 1.5.0 为准，路径相对于 pi 的包目录。
- 定位用 hostkit 的 `locatePi`：先看 `~/.pi/pane/config.json` 的 `piPath`（pi 包目录或 `cli.js` 的路径），再看 pi 官方安装脚本（`install.sh`、`install.ps1`）的安装目录（默认 `~/.pi/agent/install`，由其中的 `current-version` 指定当前版本），最后看全局 npm 根目录（`npm root -g`）下的 `@earendil-works/pi-coding-agent`。查找顺序、版本检查和 Windows 上调用 `npm` 的方式以 [pi-hostkit 设计文档的“定位 pi”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#定位-pi)为准。
- 入口是 `package.json` 的 `bin.pi`（1.5.0 中为 `dist/bundle/cli.js`）。版本不在支持范围内或找不到 pi 时，pi-pane 拒绝启动，在终端说明原因和 `piPath` 的用法。
- pi 1.5.0 要求 Node.js 22.19 及以上（`package.json` 的 `engines`），pi-pane 自己要求 Node.js 24 及以上，用同一个 Node.js（`process.execPath`）运行 pi。

## 组件

```text
浏览器（web）
   │ HTTP 命令 + 一条 WebSocket（只连 http://127.0.0.1:<port>）
   ▼
pi-pane 服务端（server）
 ├─ 鉴权、静态文件、WebSocket 事件分发
 ├─ 会话托管：SessionDriver（每个主会话一个 pi RPC 子进程）
 │    └─ 子进程里加载用户自己的 pi 扩展 + pane-bridge 扩展
 ├─ 只读会话读取：不拉起进程，直接解析会话文件
 ├─ 扩展 UI 适配：pi 原生 select/confirm/input/editor 等 → 浏览器
 ├─ 附件与图片缓存
 └─ 插件宿主：加载可信的服务端插件（如 pi-agora 的 pane 插件）
```

| 包（草案） | 职责 |
| --- | --- |
| `packages/server` | 服务端：会话托管、RPC 驱动、只读解析、鉴权、WebSocket、附件、插件宿主 |
| `packages/web` | 前端：会话列表与树、聊天视图、输入框、对话框、面板、设备密钥 |
| `packages/bridge-extension` | 加载进每个主会话的 pi 扩展（pane-bridge），见“pane-bridge” |
| `packages/plugin-api` | `@pi-pane/plugin-api`：插件接口和 pane 协议 v1 的 TypeScript 类型，按 [plugin-api.md](plugin-api.md) 导出；插件把它作为 peer 依赖 |
| `pi-hostkit`（外部依赖） | 平台相关的共享实现，见“平台支持” |

前端技术栈（草案）：Vite + Preact。选择理由是打包体积小；P0 期间可以换，但不改变接口。

## 平台支持

pi-pane 和 pi-agora 的核心都依赖共享包 [pi-hostkit](https://github.com/PosvdM/pi-hostkit)（独立仓库，两者互不依赖）。**它的权威定义是 pi-hostkit 仓库的 [`docs/design.md`](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md)**，本文只说明 pi-pane 用到哪些部分：

| hostkit 功能 | pi-pane 中的用途 |
| --- | --- |
| RPC JSONL 传输 | 读写 pi 子进程的 stdin/stdout，按 LF 切分，不用 Node.js `readline`（依据：pi `docs/rpc.md` 的“Framing”） |
| 进程树终止 | 关闭会话、空闲回收、pi-pane 退出时终止 pi 及其后代进程，流程按 [pi-hostkit 设计文档的“进程树终止”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#进程树终止)执行，pi-pane 不另写 |
| 单实例锁 | 同一个 `PI_PANE_HOME` 只运行一个 pi-pane 服务端 |
| 会话写锁 | 同一会话文件同时只有一个托管写者，与 pi-agora 共用同一协议，见“会话写锁” |
| 目录权限 | `~/.pi/pane/plugins/<id>/` 等目录只允许当前用户访问 |
| 路径规范化 | 工作目录和会话文件路径的比较、分组、哈希 |
| 进程身份记录 | 记录托管进程的 PID、创建时间等，防止 PID 复用时误杀 |

## 会话托管

### 拉起

服务端用 pi-hostkit 的 `spawnWriter` 拉起 pi：以 `process.execPath` 经启动门闩运行 pi 的 JS 入口，不经 shell；pi 的进程身份写入会话写锁的共享记录后才加载（见 [pi-hostkit 设计文档的“启动门闩”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#启动门闩)）。pi 的参数如下：

```text
node <pi>/dist/bundle/cli.js --mode rpc
  --session <sessionFile>          # 绝对路径：已有会话，或 pi-pane 预先分配的新会话路径
  -e <pane-bridge 扩展路径>
```

- 始终带 `--session <路径>`，不让 pi 自己选文件名：pi-pane 必须在 pi 打开会话文件之前持有它的写锁（见“会话写锁”）。路径必须是不依赖 pi 环境的绝对路径（不用 `~` 或相对路径），`spawnWriter` 按 pi 的参数规则核对它就是持锁的文件（见 pi-hostkit 设计文档的[“取得锁之后”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#取得锁之后)）。
- **新建会话**：按 pi-hostkit 设计文档[“取得锁的时机”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#取得锁的时机)的情况 ②，pi-pane 在会话目录下预先分配一个新文件路径，取得该路径的写锁后以 `--session <该路径>` 拉起；文件不存在时 pi 新建会话并沿用这个路径。不用 `--session-id` 或不带 `--session` 让 pi 自己生成路径。
- **Fork 为新会话**（从只读视图）：P0 实测发现 pi 的 `SessionManager.forkFrom()` 会在源文件无尾换行或尾部截断时修改源文件（末尾追加换行，并将截断行永久留在文件中间），违背对源文件的只读承诺。因此只读查看要 fork 时，pi-pane 先将源文件复制到临时目录，再在进程内对临时副本调用 `SessionManager.forkFrom(副本, cwd, sessionDir)` 生成新文件。`forkFrom()` 把传入的路径写进新文件会话头的 `parentSession`，会话列表读取这个字段（依据：`dist/core/session-manager.js` 的 `forkFrom()` 与会话列表读取）；所以在取得新文件的写锁并拉起 pi 之前，将新文件会话头的 `parentSession` 修正为规范化后的原始源文件路径；只修改新生成的文件，原始源文件保持只读。随后取得新文件的写锁，以 `--session <新文件>` 拉起，并清理临时副本。这是 pi-hostkit 设计文档[“取得锁的时机”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#取得锁的时机)的情况 ⑤（先写后锁），取锁失败时不拉起并告诉用户。不用 `--fork` 参数。M1 自动测试验证源文件字节不变，且新会话的父路径指向真实源文件。

- **不加 `-ne`**：主会话加载用户自己配置的 pi 扩展、技能、MCP，和在终端里运行 pi 一样。pi-agora 的扩展也是这样进入主会话的。
- **不加 `--approve`**：项目资源是否加载按用户的信任决定，见“项目信任”。
- `cwd` 作为 spawn 参数传入；Windows 上 `windowsHide: true`；进程组和进程树的设置按 hostkit 的进程树终止要求。
- 拉起后调用 RPC `get_state` 取 `sessionId`、`sessionFile`、模型和 thinking，再调用 `get_entries` 建立会话模型（依据：pi `docs/rpc-commands.md`）。
- 不使用 pi 导出的 `RpcClient`：它的公开声明里没有回应扩展 UI 请求的接口（依据：`dist/modes/rpc/rpc-client.d.ts`），pi-pane 用 hostkit 的 JSONL 传输自己实现。

### 会话列表

会话列表直接读 pi 的会话存储，pi-pane 不复制会话数据，终端里创建的会话也能在列表里打开。

- 存储位置按 pi 的规则确定（依据：pi `docs/sessions.md`、`docs/settings.md`）：环境变量 `PI_CODING_AGENT_SESSION_DIR` 优先，其次是 agent 目录（默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 覆盖）下 `settings.json` 的 `sessionDir`，都没有时用 `<agent 目录>/sessions/`。
- 项目的 `.pi/settings.json` 也可以设置 `sessionDir`（pi 在信任判断之前就读取它，依据：pi `docs/configuration.md`）。pi-pane 对已知的项目目录（打开过或新建过会话的 `cwd`）另外读取这个设置，把那里的会话一并列出。
- 用 pi 导出的 `SessionManager.listAll(sessionDir)` / `SessionManager.list(cwd, sessionDir)` 读取列表（依据：`dist/core/session-manager.d.ts`）。
- 按项目（工作目录）分组；每个会话显示名称、最后修改时间、消息数。默认只显示托管中、浏览器里打开着、最近 7 天活动过的会话，其余折叠进各项目下的“历史”，展开时分页加载（与 [plugin-api.md](plugin-api.md#按需加载) 的按需加载规则相同）。

### 只读查看历史会话

打开没有托管的会话时不拉起进程。异步解析、锁探测和 mtime 读取结束后，在登记前重新检查同路径记录和会话 ID；并发打开同一路径时复用已登记的记录，不能覆盖其托管写者：

- 服务端自己只读解析会话 JSONL，旧版本格式（v1、v2）在内存里迁移到 v3，不改写文件。不能用 `SessionManager.open()`：它在文件为空或需要迁移时会调用 `_rewriteFile()` 改写文件（依据：`dist/core/session-manager.js` 第 666–727 行）。
- v2/v3 条目 id 来自文件，具有稳定性；v1 在解析/迁移时派生的 id 不可作为跨进程或迁移前后的持久键（见 [plugin-api.md](plugin-api.md#三种投影)）。
- 末尾未完成的截断行，以及 pi 补换行后留在文件中间的不完整行，跳过并记录诊断，不因此判为文件损坏。在线与离线的叶子计算采用统一规则；P0 的一致性结论限于文件重新打开语义，不保证运行中导航后尚未追加条目时两者叶子相同。
- 只读视图监视文件的修改时间，变化时发 `resync` 重新解析。异步读取提交前核对文件映射、模型及 epoch、启动归属，并确认仍未托管且未关闭；跨越启动或切换的旧读取不能重置新绑定的模型。
- 用户第一次在只读视图里发送消息时，服务端按“会话写锁”的规则拉起进程，之后转为托管会话。

### 会话写锁

写锁的协议、共享记录 `SessionLockRecord`、取得和释放的时机、取得锁之后的遗留写者清理**以 [pi-hostkit 设计文档的“会话写锁”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#会话写锁)为准**，本文不重复定义。pi-agora daemon 使用同一协议，所以两者不会同时托管一个会话文件。

- pi-pane 使用 hostkit 规定的共享目录 `~/.pi/hostkit/locks/`（三个平台相同；Windows 上锁本身是命名 mutex，目录里只有记录），不在自己的数据目录里另存锁状态。
- pi-pane 在以下位置调用写锁（编号对应 pi-hostkit 设计文档[“取得锁的时机”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#取得锁的时机)表中的情况）：

| 场景 | hostkit 情况 | pi-pane 的做法 |
| --- | --- | --- |
| 打开已有会话 | ① | 拉起 pi 之前取得写锁 |
| 新建会话 | ② | 预先分配路径、取得写锁后以 `--session <路径>` 拉起（见“拉起”） |
| 从只读视图 Fork | ⑤ | 在 pi-pane 进程里对临时副本调用 `forkFrom()` 创建新文件、修正新文件的 `parentSession` 后取得写锁，再拉起（见“拉起”） |
| 进程内切换到已有会话 | ③ | 见“会话切换” |
| 进程内 new、fork、clone | ④ | 见“会话切换” |
| 关闭、回收 | — | 确认 pi 进程树已退出后释放 |
| 取得锁之后 | — | 首次拉起和目标切换共用恢复检查：按 hostkit 清理遗留 pi，再检查每份 StopReport，报告不完整时不登记新 writer |

- 恢复失败、抛错或报告含失败的 snapshot/verify、无法确认的残留时，不登记新 writer。错误、旧记录及报告保存在 pane 数据目录的 `recovery/<会话路径哈希>.json`；该文件同时是持久隔离标记，阻止首次拉起和目标切换，重启服务端也不自动清除，`assumeNoWriter` 不能绕过它。
- hostkit 恢复成功但 pane 拒绝报告时，pane 保留内核锁及旧 writer 身份，共享记录为 `stopping`，直到宿主退出。hostkit 的 `recoverPreviousWriter()` 返回 `failed` 或抛错时已经自行释放内核锁，pane 不声称仍持有该锁。此时共享记录未被恢复流程改写，仍保留旧写者；其他宿主虽然能取得内核锁，但必须自行执行 hostkit 恢复检查，不能直接调用 `spawnWriter()` 成为新写者。跨宿主保护依赖该恢复契约，pane 自己的隔离标记仅约束使用同一数据目录的 pane。

**维护者解除隔离**：

1. 停止使用该数据目录的 pane 服务，等待宿主退出，以释放可能保留的内核锁。不要在运行中的服务上直接删除隔离标记。
2. 从 `recovery/<会话路径哈希>.json` 读取 `sessionFile`、`previous.host.identity`、`previous.writer` 和 `reports`，保留诊断副本。对照 `~/.pi/hostkit/locks/` 中对应会话的共享记录，保存该记录和相关停止报告；诊断中的会话路径必须与要恢复的文件一致。
3. 独立核查旧宿主、writer 及报告中的残留进程：按 PID、创建时间、runId、instanceId 核对身份，检查报告覆盖范围内的进程树或容器，确认没有仍在写该文件的进程。仅凭 PID 不存在或根进程退出不足以解除隔离。若共享记录指向另一个活跃宿主，先与该宿主协调停止；身份或残留状态无法确认时保持隔离。
4. 确认所有相关写者已退出、保存诊断后，仅移除对应的 pane `recovery/<会话路径哈希>.json`。不要删除或伪造 hostkit 共享记录来跳过恢复检查。
5. 重启 pane，再次打开会话。首次发送仍执行正常的取锁与恢复检查；若再次隔离，保留新报告并继续核查，不使用强制忽略开关。
- 写锁被另一个托管写者持有时，会话以只读方式打开（`readonlyReason = "externalWriter"`），显示持有者（如“由 pi-agora 托管”），提供“Fork 为新会话”。
- 终端里直接运行的 pi 不参与写锁，pi-pane 无法确认它是否在写。打开会话前文件在最近 60 秒内被修改过时，pi-pane 提示“该会话可能正在别处运行”，提供“只读打开”和“Fork 为新会话”两个选项。强制与外部写者同时写入不支持。
- pi-pane 打开之后终端里才开始写同一文件的情况检测不到，列入剩余风险。

### 会话切换

托管中的 pi 进程可能被切换到别的会话文件：pi-pane 自己发出的 RPC `new_session`、`fork`、`clone`，或扩展命令调用的 `newSession`、`fork`、`switchSession`。pane-bridge 监听切换事件，经回连通道请服务端取锁并回报（依据：`dist/core/extensions/types.d.ts` 的 `SessionBeforeSwitchEvent`、`SessionShutdownEvent`、`SessionStartEvent`）。取锁时机按 pi-hostkit 设计文档[“取得锁的时机”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#取得锁的时机)的情况 ③ 和 ④。

**切换到已有会话（③）**：pi-pane 的斜杠命令不发 `switch_session`（`/resume` 打开 pi-pane 的会话列表，另起进程打开），所以这种切换只会由扩展命令发起。pane-bridge 在 `session_before_switch`（`reason: "resume"`，带 `targetSessionFile`）里同步请服务端取得目标文件的写锁；拿不到时返回 `{ cancel: true }`，切换不发生，浏览器收到通知“目标会话正被别处托管”。

**新建或分叉（④）**：新文件的路径由 pi 生成，最早在 `session_shutdown` 的 `targetSessionFile` 里出现，pane-bridge 这时请服务端取得新路径的锁；带叶子的 fork 和 clone 会先写出新文件再取锁。新文件名带新生成的会话 id，实际不会冲突，但仍要处理取锁失败：

- **pi-pane 自己发起**：斜杠命令 `/new`、`/fork`、`/clone` 走 RPC `new_session`、`fork`、`clone`，不经过扩展命令。发送前控制队列暂停向该进程发送其他输入，等切换结果出来后再恢复。
- **扩展命令发起**：pi-pane 事先不知道，只能在 `session_shutdown` 时取锁。
- **取锁失败**（两种发起方式相同）：服务端不再向该进程发送任何输入，在新会话的 `session_start` 之后按 hostkit 的流程停止该进程，把会话标为 `interrupted`，并提示用户“新会话的文件正被别处托管，已停止”。

**切换成功后**（收到新会话的 `session_start`，带 `previousSessionFile`）：

1. 服务端调用 `get_state` 取新的 `sessionId` 和 `sessionFile`，再用 `get_entries` 重建会话模型。目标已只读打开时，复用目标记录和模型，向已有订阅发 `resync`，保留订阅、客户端计数、保活及活动时间；进程事件、退出回调及活动控制队列随写者迁移到该目标记录，旧会话使用空队列。目标本身正在处理控制操作时拒绝重绑定并停止切换写者，避免两条控制队列并行驱动同一进程。
2. 控制队列等新的 pane-bridge 实例就绪后才恢复（见“会话替换后的重绑定”）。新会话节点变为托管中，进程的事件流更换 epoch；旧文件的写锁按 hostkit 在新会话的 `session_start` 之后释放；旧会话节点变为未托管，保留在树中，可以只读查看。
3. 正在查看旧会话的标签页收到 `pane_session_replaced`，显示“此会话的进程已切换到 <新会话>”和“打开新会话”按钮，然后转为只读视图。

**切换没有发生**（被扩展取消，没有等到新会话的 `session_start`，且 `get_state` 的 `sessionFile` 仍是旧文件）：服务端释放已取得的目标锁，恢复控制队列。RPC 已确认的控制结果与这一步清理分别处理；状态查询或释放失败时记录 `pane_diagnostic`，保留尚未释放的锁并停止写者，确认进程退出后才释放。清理故障不覆盖已确认的 RPC 响应，同一 requestId 仍返回真实控制结果。

`reason: "reload"` 不换会话文件，只更换 epoch 并重建模型。

### 项目信任

RPC 模式不显示 pi 内置的信任提示。启动阶段交给 `project_trust` 处理器的上下文也不是 RPC 的扩展 UI：非 interactive 模式下 `hasUI` 为 false，`ctx.ui.confirm` 直接返回 `false`，`select`/`input` 返回 `undefined`（依据：`dist/main.js` 第 599–629 行、`dist/cli/project-trust.js`）。所以信任询问不能走 `ctx.ui`。

pi 决定信任的顺序（依据：`dist/core/project-trust.js` 的 `resolveProjectTrusted`、`dist/core/extensions/runner.js` 第 109–136 行的 `emitProjectTrustEvent`）：

1. 命令行 `--approve`/`--no-approve`；
2. 目录里没有需要信任的项目资源时，返回 `ProjectTrustStore.get(cwd) ?? true`：已有保存决定时使用该决定（包括父目录继承的决定），否则视为信任；此分支不调用 `project_trust` 处理器；
3. 按扩展加载顺序调用 `project_trust` 处理器，第一个返回 `"yes"` 或 `"no"` 的生效，`"undecided"` 交给下一个；
4. `trust.json` 里保存的决定；
5. `defaultProjectTrust`：`"always"` 加载，`"never"` 不加载，`"ask"` 在 RPC 下因为没有 UI 而不加载。

**主方案：拉起前在浏览器询问**

- 拉起一个会话之前，服务端用 pi 导出的 `hasTrustRequiringProjectResources(cwd)` 和 `ProjectTrustStore`（依据：`dist/index.d.ts` 第 28 行）判断该目录是否有需要信任的资源、是否已有保存的决定。注意：没有资源的目录，如果 `trust.json` 里记的是 false，同样当作不信任。有资源且没有保存的决定时，浏览器显示“是否信任项目 <cwd>？”，选项为“信任”“不信任”和“记住此选择”。这一步发生在用户打开或新建会话的那个标签页里，用户一定在场。
- 决定不用 `--approve`/`--no-approve` 传给 pi：命令行覆盖对该进程内所有目录生效，进程内切换到别的项目时也会沿用。服务端把“目录 → `{ trusted, remember }`”放进 pane-bridge 的启动配置（随回连通道的兑换响应下发），比较路径前先做 `realpath`（例如 macOS 上系统临时目录 `event.cwd` 在 `/private/var` 与 `/var` 的符号链接差异）；pane-bridge 的 `project_trust` 处理器只对匹配的目录返回这个决定，返回值按 pi 的类型 `{ trusted: "yes" | "no" | "undecided", remember?: boolean }`（依据：`dist/core/extensions/types.d.ts` 第 558–562 行）；`remember: true` 时由 pi 写入 `trust.json`。
- 用户关闭询问框或没有作答时，处理器返回 `"undecided"`。
- 同一 pi-pane 运行期间对同一目录的回答缓存在服务端内存里（未勾选“记住”时只对本次运行有效），重新拉起时不再询问。

**补充：进程内切换到新目录**

进程内切换会话进入一个新的工作目录时，pi 会再次触发 `project_trust`，而这个目录事先不知道。pane-bridge 的处理器经回连通道请服务端在浏览器询问。询问期间会话切换会被阻塞，最长会卡 60 秒（处理器超时）。因此 pane 必须提前预判信任状态、及时弹出询问，不能让用户干等；60 秒内没有回应、没有浏览器连接或回连不可用时返回 `"undecided"`。

**`"undecided"` 不等于不加载**

pane-bridge 返回 `"undecided"`，或它的决定被更早加载的扩展抢先，最终结果由上面顺序的其余步骤决定：其他处理器可能返回 `"yes"`，`trust.json` 里可能已有 yes，`defaultProjectTrust` 可能是 `"always"`，这些情况都会加载项目资源。所以 pi-pane 不推测结果：pane-bridge 在每次 `session_start` 时调用 `ctx.isProjectTrusted()`（依据：pi `docs/extensions.md`）把实际结果报给服务端，会话视图按实际结果显示“项目资源已加载”或“未加载”；与用户的选择不一致时加注“由其他扩展或已保存的设置决定”。

其他：

- 不对所有会话统一加 `--approve`。
- 页面上注明：信任只决定是否加载项目的设置和资源，`AGENTS.md` 等上下文文件不受信任控制，始终加载（依据：pi `docs/security.md`）。
- P0 验证结论：`ProjectTrustStore` 预判、pane-bridge 处理器及 `isProjectTrusted()` 的实测结果完全一致。没有资源的目录在 `trust.json` 记为 false 时同样不加载资源；切换会话时路径两端需 realpath 匹配。

### 停止与控制队列

每个托管会话的普通控制操作串行执行，包括发送、切换模型和斜杠命令。`stop`、`close`、`restart` 使用停止优先通道，不等待队首 RPC 的 Promise；同一会话同时只执行一个停止类操作。

两个条件检查各管一件事：

- **epoch**：隔离进程和会话的替换。浏览器的会话命令都带上它看到的 `expectedEpoch`（会话游标的 epoch）。进程重启或切换了会话后 epoch 不同，服务端拒绝命令（HTTP 409 `epochChanged`），浏览器重新取快照并提示用户，避免把消息发进另一个会话。
- **控制状态 revision**：隔离同一会话内状态的变化。服务端为每个托管会话维护控制状态（运行阶段 `idle`/`running`/`compacting`/`stopping`、模型、thinking 级别），任一项变化时 `controlRevision` 加 1；它出现在快照和每条 `pane_status` 事件里。

| 命令 | 必须带 | 冲突（409 `revisionChanged`）后的处理 |
| --- | --- | --- |
| 发送（`prompt`/`steer`/`follow_up`） | `expectedEpoch`、`expectedRevision` | 用哪个 RPC 命令取决于用户看到的运行状态。浏览器重新读取状态：会话已开始运行时让用户选择“追加（steer）”“排队（follow-up）”或“取消”；已经停下时询问是否作为新消息发送。草稿保留，不自动重发 |
| 停止 | `expectedEpoch`、`expectedRevision` | 用户看到的那次运行已结束或已在停止时不重复执行，显示当前状态 |
| 关闭会话 | `expectedEpoch`、`expectedRevision` | 重新显示当前状态和 hold 原因，请用户再次确认 |
| 切换模型、thinking | `expectedEpoch`、`expectedRevision` | 另一个标签页刚改过时显示新值，由用户决定是否覆盖 |
| `/compact`、`/new`、`/fork`、`/clone`、`/name`、`/export` | `expectedEpoch`、`expectedRevision` | 重新读取状态后由用户重新发起 |
| 回应扩展 UI 对话框 | `expectedEpoch` | 以对话框的请求 id 为准，已回应或已超时的返回“已处理” |

普通操作在控制队列中执行前比较条件。停止类操作也先检查 epoch、revision 和关闭确认，再取消尚未执行的排队操作（`controlPreempted`）；启动中的操作收到取消信号，迟到的进程在发送输入前被停止。已发送的 RPC 不伪造取消结果，仍记录真实响应；进程停止而未收到响应时记为 `rpcResultUnknown`。
- **准入上限**：每会话最多排队 64 项，超过时返回 HTTP 429 `controlQueueLimit`；停止优先通道不占普通队列。全服务最多保留 256 项未完成的普通请求，停止类请求另保留 16 项额度，超过时返回 HTTP 429 `pendingLimit`。达到上限不删除已有 pending 幂等记录，同 requestId 的查询和结果重放仍可使用。停止期间的新操作返回 `controlStopping`。
- **停止（取消）**：会话视图的“停止”按钮。服务端进入 `stopping` 状态，先发 `clear_queue`，把返回的 steering 和 follow-up 文本按原顺序放回输入框（放在现有草稿之前，用空行分隔），再发 `abort`。P0 实测证明：只发 `abort` 时排队消息留在队列里、不会自动执行，而且排队的 agora 通知之后会重复落盘，所以 pane 不提供只发 abort 的操作（不提供“只停止当前回复”菜单项）。
- **队列里的图片**：`clear_queue` 只返回文字。服务端记录每条排队消息的草稿（含图片节点），按文字找回对应草稿后整条放回输入框；带图片的消息文字里有随机标记（见 [image-placeholders.md](image-placeholders.md#做法发送时编码message_end-时还原)），可以唯一对应。
- **超时与抢占**：`abort` 会等会话空闲后才响应。服务端默认等待 10 秒，超时后自动按 hostkit 流程终止进程树。抢占活动控制操作时，即使 `abort` 返回，也停止进程，以结束可能仍挂起的扩展命令及全部 RPC 等待项；停止报告与进程身份复查完成后才释放写锁。已进入桥接事件的目标取锁若在停止后才返回，不登记新的 running writer，等待该停止确认后释放迟到锁；清理无法确认时保留锁并记录诊断。
- **运行记录清理**：每个 handle 的运行记录写入串行执行。停止后才进入持久化队列的写入直接跳过；已进入的写入（包括临时文件 rename）结束后，停止才删除临时文件和运行记录。不等待尚未进入持久化的初始化收尾，迟到初始化也不能重新创建运行记录。
- **stopping 期间**：拒绝新的发送（提示“正在停止”），直到收到 `agent_settled` 或进程退出。进入和离开 `stopping` 都会使 `controlRevision` 加 1。
- 控制操作受理时递增 `controlRevision`，不因此把阶段推测为 `streaming`。运行阶段由 `agent_start`、工具、压缩等实际事件更新；扩展命令或输入处理器返回 `disposition: "handled"`、prompt 预检被拒绝时，空闲会话仍为空闲。手动压缩的 `compaction_end.reason = "manual"` 表示原回合已中止且不会继续生成，无论成功、扩展取消或 provider 失败均回到空闲，不依赖成功 RPC 响应或后续 `agent_settled`。自动压缩仍保持生成阶段，等待实际 `agent_settled`；手动压缩成功响应后另外用 `get_state` 核对状态。已确认成功的控制响应不会因后续快照查询失败而改记为失败。
- 运行结束以 `agent_settled` 为准，不以 `agent_end` 为准：`agent_end` 之后仍可能有重试、压缩恢复或队列消息（依据：pi `docs/json.md`）。

### 关闭与回收

- 用户在界面上关闭会话：按“停止”的顺序先 `clear_queue` 再 `abort`（清出的文本存入该会话的浏览器草稿），等运行结束后关闭 stdin，宽限 5 秒后按 hostkit 的流程终止进程树，释放写锁。会话文件不受影响。
- 空闲回收：会话已 settled、没有待回应的扩展 UI 对话框、没有浏览器连接、没有插件 hold，持续 30 分钟后按上一条停止子进程（`mainIdleReclaimMs`，默认 1800000）。再次打开时只读显示，发送时重新拉起。
- 插件 hold：被 hold 的会话不做空闲回收，树节点和会话视图底部显示原因（如“等待子代理”）；用户主动关闭时先列出原因请用户确认。接口见 [plugin-api.md](plugin-api.md#保活)。
- pi-pane 退出时先设置关闭门禁，再按同样顺序关闭所有托管会话。关闭期间拒绝打开会话，未完成的打开请求也在登记前复查；就绪回调不能把写者迁入关闭遍历已经经过的记录。首次发送和 restart 在信任询问及目录读取之前登记在途启动，关闭取消并等待其清理。driver 在取锁及恢复结束后检查取消，取消时释放锁且不 spawn；spawn 已开始时，创建 handle 后立即交给会话管理器，停止无需等待首次持久化或就绪。
- 服务关闭在进程停止后另外排空在途目标取锁及初始化，包括退出回调已经摘下 handle 的写者；目标锁在停止确认后释放。`exited` 只表示退出回调已执行，独立 handle 登记须等缓存的停止结果和排空均成功后才能删除；停止失败即使先于关闭、重绑定或成功重启，也保留到关闭汇总。单个 handle 的 stop 不等待整个初始化，避免与目标锁清理形成循环等待。全部启动和写者排空后才关闭 HTTP、释放实例锁；清理未确认时关闭返回失败并保留实例锁。并发关闭调用等待同一结果。pi-pane 被强杀时子进程的清理由 hostkit 负责。

- 本实例取得写锁后的恢复失败、启动清理释放失败及启动时运行记录恢复失败，由实例级清理错误集合保存，关闭时汇总并保留实例锁；记录隔离诊断失败也不能覆盖该错误。启动前已有的 `recovery/` 隔离标记仅列入 `Sessions.recoveryDiagnostics`，CLI 输出其文件名，正常关闭不因此失败；标记仍阻止对应会话自动托管，须按会话写锁节的维护流程处理。

### 会话驱动接口

实现位于 `packages/server/src/driver.ts`。`DriverSpec` 包含 cwd、sessionFile、sessionDir、信任决定和可选 assumeNoWriter；driver 负责取得并恢复写锁。扩展、环境和停止期限由 DriverOptions 配置。

```ts
interface SessionDriver {
  start(spec: DriverSpec, callbacks: DriverCallbacks, signal?: AbortSignal): Promise<DriverHandle>;
}
interface DriverCallbacks {
  onHandle?(handle: DriverHandle): void; // 创建后、首次持久化前交付。
  onCleanupFailure?(error: unknown): void; // 本实例恢复或创建 handle 前的清理未确认。
  onRecord(event: any): void;
  onReady(state: any, entries: any, reason: string, handle: DriverHandle): void;
  onExit(reason: string, report?: StopReport, error?: unknown): void;
}
interface DriverHandle {
  readonly identity: ProcessIdentity;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  readonly sessionFile: string;
  readonly acceptingInput: boolean;
  send(cmd: RpcCommand, opts?: { timeoutMs?: number; trackResult?: boolean }): Promise<RpcResponse>;
  respondUi(res: ExtensionUiResponse): void;
  stop(): Promise<StopReport>;
  drain(): Promise<void>; // 等待 stop、在途目标取锁及初始化，保留停止和清理失败。
}
```

## 浏览器与服务端的数据流

### 通道

- **命令**：HTTP `POST /api/...`，带 `Authorization` 头（见“鉴权”）。每个命令带 `requestId`（同时作为幂等键），会话命令还按“停止与控制队列”的表带 `expectedEpoch` 和 `expectedRevision`。如发送消息、steer、停止、切换模型、回应对话框、调用插件动作、提交表单、上传图片。
- **幂等**：同一 `requestId` 的命令只执行一次。HTTP 等待默认 30 秒（`rpcTimeoutMs`），等待到期返回 `{ status: "pending" }`，不取消底层控制操作、不完成幂等记录。控制 RPC 保留响应等待项，直到实际响应或传输关闭，信任询问、长时间压缩等操作的迟到结果仍写回同一记录。重复提交时服务端返回这次操作的**当前**状态：仍在执行就返回“处理中”，已结束就返回最终结果；最终结果至少保留 24 小时。传输中断且没有确认响应时返回 `rpcResultUnknown`，要求读取会话状态核对；只有 pi 明确拒绝的响应属于 `rpcRejected`。同一 `requestId` 配不同的命令内容时拒绝（HTTP 409 `idempotencyConflict`）。服务端重启后幂等记录丢失，此时 epoch 已经改变，旧命令会被 epoch 检查拒绝。
- **事件**：一条 WebSocket `/ws`。浏览器订阅关心的会话和插件来源，服务端推送事件。

```ts
// 服务端 → 浏览器，草案
type ServerMessage =
  | { type: "session"; ref: SessionRef; cursor: StreamCursor; event: object } // pi 会话事件、pane_* 事件或 resync
  | { type: "tree"; source: string; change: TreeChange }
  | { type: "panel"; update: PanelUpdate }
  | { type: "ui_request"; ref: SessionRef; request: ExtensionUiRequest }       // pi 原生扩展 UI
  | { type: "form"; form: FormSpec }
  | { type: "formRemoved"; formId: string; reason: FormRemovedReason }
  | { type: "presence"; request: { id: string; title: string; summary: string; payload: unknown; source: string } }
  | { type: "notification"; notification: PaneNotification }
  | { type: "banners"; banners: BannerState[] }   // 当前全部横幅，整体替换
  | { type: "banner"; banner: BannerState }       // 新增或替换一条（含来源插件状态变化）
  | { type: "bannerCleared"; source: string; id: string };
```

`BannerState` 是 `PaneBanner` 加上 `source` 和 `sourceUnavailable: boolean`（见 [plugin-api.md](plugin-api.md#横幅)）。`SessionRef`、`StreamCursor`、`TreeChange`、`FormSpec`、`PaneNotification` 等类型由 pane 协议 v1 定义（[plugin-api.md](plugin-api.md)）。主会话的 `SessionRef` 是 `{ source: "pane", id: <piSessionId> }`。

### 会话模型

服务端为每个托管会话维护一个会话模型：已持久化的条目（来自 `get_entries`）、当前叶子、进行中状态 `InFlightState`（结构见 [plugin-api.md](plugin-api.md#sessionsnapshot)）。

- 从 pi stdout 按顺序读到的每条记录（会话事件或命令响应）在同一次处理中更新模型；会话事件和 pane 自己产生的事件（`pane_entries`、`pane_status` 等）分配下一个 `seq`。
- 收到 `message_end`、`entry_appended`、`compaction_end`、`session_info_changed`、`agent_settled`，以及 `fork`、`compact` 等改变条目的命令响应后，服务端调用 `get_entries` 并带上已知最后一个条目 id 作为 `since`，把新条目作为 `pane_entries` 事件发出。返回的 `leafId` 不在已知叶子的后代上时，说明活动分支变了，服务端重建模型并发 `resync`。
- `message_end` 在 pi 写入会话文件之前发出（依据：`dist/core/agent-session.js` 第 760–779 行），这段时间里消息放在 `inFlight.completed`，等 `pane_entries` 到达后替换。
- 用户聊天视图（② 投影）由模型从叶子沿父链算出；会话视图不用 `get_messages`。三种投影的定义见 [plugin-api.md](plugin-api.md#三种投影)。
- 重绑定为旧文件复制只读记录时清空 syncing、重置 dirty；旧记录重新托管后独立发起条目同步，不复用迁走对象的同步 Promise。

### 快照与切点

- 浏览器打开会话：`GET /api/sessions/:id/snapshot` 取快照，再通过 WebSocket 用快照的 `cursor` 订阅。
- 快照是对会话模型的一次同步读取，返回的 `entries`、`inFlight` 和 `cursor` 属于同一时刻：游标之前的事件都已反映在快照里，订阅从游标之后的第一条事件开始。因为模型更新和 `seq` 分配在同一次处理中完成，两者之间没有可以插入事件的空隙。
- 快照只带聊天视图的最后一页（默认 50 条）和历史水位 `historyBefore`。向上滚动时 `GET /api/sessions/:id/history?before=<entryId>` 取更早的页，规则见 [plugin-api.md](plugin-api.md#sessionsnapshot)。
- **条目与图片分离**：P0 实测表明大图会导致全量 `get_entries` 耗时急剧上升。因此重连和快照**只用 `since` 增量取条目**，不全量取；快照中只放图片的引用（哈希/URL），浏览器显示时再单独异步取图。M1 实测后固定单张图片上限为 4 MiB；观测值见 [development.md](development.md#图片上限观测)。

### 游标与重连

- 每个会话的事件游标是 `{ epoch, seq }`。服务端启动、进程重启、进程切换会话、模型重建时生成新的 epoch。
- 服务端在内存中保留每个会话最近 2000 个事件，同时使用 32 MiB 字节限额；单条事件可以保留。
- 断线重连：带上最后收到的游标重新订阅。epoch 不同、`seq` 大于当前最新值、或该 `seq` 之后的事件已不在缓冲区时，服务端发 `resync`，浏览器重新取快照。
- `message_update` 只带增量（依据：pi `docs/json.md`），浏览器按 `contentIndex` 拼接，`*_end` 和 `message_end` 到达后用完整内容替换。

### steer 与 follow-up 的送达

pi 的 `queue_update` 事件只带当前队列的文字（依据：pi `docs/json.md`）；用户消息开始时，pi 按完全相同的文字从队列里删掉第一条匹配项（依据：`dist/core/agent-session.js` 第 738–757 行）。pi-pane 的处理：

- 输入框上方的“排队中”列表以最近一次 `queue_update` 为准。
- 一条已排队的消息从队列中消失、且出现文字相同的用户消息时，标为“已送达”。
- 文字完全相同的多条消息无法区分，按先进先出对应，这和 pi 删除第一条匹配项的行为一致。带图片的消息文字里有随机标记，不会重复。
- `steer`/`follow_up` 响应的 `disposition` 为 `"handled"` 时（被扩展的输入处理器消费），消息不进入队列，直接标为“已处理”（依据：pi `docs/rpc-commands.md`）。
- 被 `clear_queue` 清出的消息回到输入框，见“停止与控制队列”。

### 慢客户端

- 服务端读 RPC stdout 不受浏览器影响，浏览器慢不会阻塞 pi。
- 某个 WebSocket 的发送缓冲超过 1 MiB：同一消息的连续文本增量合并后再发；超过 8 MiB：丢弃该连接的待发增量，发送 `resync`。

## 斜杠命令

RPC 的 `prompt` 只执行扩展命令、技能（`/skill:name`）和提示模板，pi 的内置命令（`/settings`、`/compact` 等）在 RPC 下不执行（依据：pi `docs/rpc-commands.md` 的 `get_commands`）。输入框拦截以 `/` 开头的输入：

| 输入 | pi-pane 的处理 |
| --- | --- |
| `/compact [说明]` | RPC `compact`，`customInstructions` 为说明 |
| `/model [provider/model]` | 有参数时 RPC `set_model`；无参数时打开模型选择 |
| `/thinking [level]` | RPC `set_thinking_level`；无参数时打开选择 |
| `/new` | RPC `new_session`，按“会话切换”处理 |
| `/name [名称]` | RPC `set_session_name`；无参数时显示当前名称 |
| `/export` | RPC `export_html`，输出路径在 pi-pane 的临时目录里，完成后提供下载 |
| `/fork` | 用 `get_fork_messages` 列出可选的用户消息，选中后 RPC `fork` |
| `/clone` | RPC `clone` |
| `/resume` | 打开 pi-pane 的会话列表 |
| `/session` | 显示 `get_state` 和 `get_session_stats` 的信息 |
| `/quit` | 关闭会话 |
| `get_commands` 返回的扩展命令、技能、提示模板 | 原样通过 `prompt` 发送 |
| 其他（如 `/settings`、`/tree`、`/reload`、`/login`） | 不发送，提示“pi-pane 不支持 /xxx，请在终端中使用 pi” |

输入 `/` 时，补全列表包含上表的内置命令和 `get_commands` 返回的命令（显示 `description` 和来源）。会话的扩展重新加载或切换后重新获取。

## 鉴权

**浏览器支持范围**：pi-pane **只支持 Chrome**。其他浏览器（包括 Edge 等 Chromium 内核的）不测、不承诺。

### 规范源与监听

- 只监听 `127.0.0.1`（端口默认 4319，配置项 `port`）。
- 只服务规范源 `http://127.0.0.1:<port>`：每个 HTTP 请求和 WebSocket 握手的 `Host` 头必须正好是 `127.0.0.1:<port>`，否则拒绝（防 DNS 重绑定）。`localhost` 也拒绝，终端里打印的地址始终用 `127.0.0.1`。
- 带 `Origin` 头的请求，`Origin` 必须是规范源；不开放 CORS。
- 浏览器的设备密钥存在 IndexedDB，按源隔离：端口或源改变后浏览器看到的是一台新设备（见 [plugin-api.md](plugin-api.md#设备密钥)）。改端口前应知道插件后台服务会要求重新批准设备。

### 配对码与会话凭证

- pi-pane 不在磁盘上保存任何访问凭证，也不使用 Cookie：Cookie 不按端口隔离，同机其他 `127.0.0.1` 服务会收到。
- 启动时在终端显示一次性配对码和带码的地址 `http://127.0.0.1:4319/#code=<配对码>`。配对码至少 64 位随机数，用一次即失效，10 分钟未使用也失效；同一配对码连续输错 5 次后作废。
- 浏览器读取地址中的配对码（`#` 之后的部分不会发给服务器，也不会进入服务器日志），调用 `POST /api/auth/pair` 换得会话凭证，随后用 `history.replaceState` 从地址栏移除配对码。也可以在登录页手动输入配对码。
- 会话凭证只放在内存和 `sessionStorage`，所有 HTTP 请求用 `Authorization: Bearer <凭证>` 发送。
- 会话凭证只在服务端内存里登记：服务端重启后全部失效；24 小时无活动失效；设置页的“退出登录”立即吊销。
- 需要新配对码时：在运行 pi-pane 的终端里按 Enter 显示一个新的；或在已登录浏览器的设置页点“添加浏览器”生成。pi-pane 不提供用命令行生成配对码的方式，因为子代理也能运行命令行。
- **运维代价**：pi-pane 在后台运行、没有终端时，只能由已登录的浏览器生成配对码。所有浏览器标签页都关闭或退出登录后，只能在终端里重启 pi-pane 取得新的配对码；重启会停止所有托管中的会话。

### 标签页之间共享凭证

`sessionStorage` 按标签页隔离，同一浏览器新开的标签页通过同源的 `BroadcastChannel` 从已登录的标签页取得凭证，不需要新的配对码：

- 服务端每次启动生成新的 `instanceId`。`GET /api/instance` 不需要鉴权，只返回 `instanceId`；配对响应也带 `instanceId`，标签页把凭证和它一起保存。
- 新标签页先取当前 `instanceId`，再在频道里请求属于这个 `instanceId` 的凭证；已登录的标签页只在自己保存的 `instanceId` 相同时回应。服务端重启后，旧标签页不会把已失效的凭证发给新标签页。
- 任一请求收到 401 且响应说明 `instanceId` 已变时，标签页清除自己保存的凭证，显示配对页。
- “退出登录”：服务端吊销该凭证，发起的标签页在频道里广播 `logout`，同一浏览器里使用该凭证的标签页都清除凭证。没有收到广播的标签页（如已休眠）下次请求时会收到 401，结果相同。已建立的 WebSocket 连接在吊销时由服务端关闭。

### WebSocket

- 握手时校验 `Host` 和 `Origin`，但不在 URL 或握手头里带凭证。
- 浏览器先用 `Authorization` 头调用 `POST /api/ws-ticket` 取一张一次性 ticket（30 秒有效），连接后发送的第一帧必须是 `{ "type": "auth", "ticket": "…" }`。5 秒内没有收到有效的首帧时服务端关闭连接。
- 首帧之前服务端不推送任何数据，也不处理其他帧。
- 鉴权通过后，服务端先发一条 `banners`（当前全部插件横幅），再处理订阅。每次重连都一样，所以横幅不依赖事件缓冲。

### 其他规则

- 所有响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- 浏览器不持有插件后台服务（如 pi-agora daemon）的任何凭证，插件在服务端代为访问。
- pi-pane 不检查请求对端的进程（PID）。
- pane-bridge 的回连通道是另一套接口，只能对它所在的会话做 Agent 级的事（见“pane-bridge”），不能调用浏览器使用的 `/api`。

## 用户在场确认与设备密钥

浏览器第一次登录时用 WebCrypto 生成不可导出的 ECDSA P-256 设备密钥，存在 IndexedDB。插件调用 `ctx.userPresence.confirm()` 时，浏览器弹出确认框，用户点击确认后签名，插件的后台服务验签。pi-pane 只负责生成、保存密钥和签名，不判断设备是否可信；设备的首次信任（TOFU）和批准由插件后台服务负责。接口、签名格式和流程见 [plugin-api.md](plugin-api.md#用户在场确认)。

## 渲染与资源安全

会话内容、工具输出、插件内容都可能来自模型或不可信文件，按不可信内容渲染：

- **Markdown**：禁用原始 HTML（按文本显示）。链接只允许 `http:`、`https:`、`mailto:` 和页面内锚点，其他 scheme（`javascript:`、`data:`、`vbscript:`、`file:` 等）去掉链接只保留文字。外部链接带 `rel="noopener noreferrer"`，在新标签页打开。
- **远程图片**：Markdown 里的远程图片默认不加载，显示为链接“远程图片：<域名>”，用户点击后在新标签页打开。这样模型输出里的图片地址不能在用户不知情时把数据带出去。
- **会话中的图片**：只显示 PNG、JPEG、GIF、WebP，经服务端按哈希提供（见 [image-placeholders.md](image-placeholders.md#历史消息中的图片)）；SVG 等其他类型只显示类型和大小。
- **工具参数、工具结果、差异、扩展对话框文字**：按纯文本显示。
- **CSP**：`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; connect-src 'self' ws://127.0.0.1:<port>`。不允许内联脚本和 `eval`。
- **附件接口**：`/api/assets/*` 和 `/api/blobs/*` 需要鉴权，只按格式校验过的哈希 id 读取 pi-pane 自己的存储目录，不接受文件路径参数，不能读任意本地文件。`<img>` 标签无法带 `Authorization` 头，所以前端用 `fetch` 取回后转成 `blob:` URL 显示。
- **导出**：`/export` 的输出路径由 pi-pane 指定在自己的临时目录里，下载接口只提供该目录下由本次导出生成的文件。

## 剩余风险

Agent（主代理和子代理）与用户是同一个操作系统用户，在同一个桌面会话里运行。pi-pane 的设计只拦低成本的冒充（读文件 + curl）和误操作；存心冒充需要多步操作、通常在屏幕上可见并留下痕迹，但无法阻止。具体如下：

- **拦得住的**：pi-pane 的 HTTP 接口没有落盘的凭证，Agent 读文件拿不到；配对码只显示在终端屏幕上，没有生成配对码的命令行。
- **系统自动化**：Agent 可以借系统自动化工具（macOS 的 `osascript`/System Events、Windows 的 SendKeys/UI Automation、Linux X11 下的 `xdotool`）向 pi-pane 所在的终端输入（包括按 Enter 生成新配对码并读取屏幕），也可以操作浏览器替用户点确认，包括利用 Chrome 的“允许 Apple 事件中的 JavaScript”或远程调试端口。
- **浏览器数据**：IndexedDB 数据在磁盘上，不可导出的设备私钥仍可能从中挖出。
- **首次配对**：插件后台服务的首台设备采用 TOFU，如果 Agent 抢先完成，会被冒充。设备的重置由插件后台服务自己处理（pi-agora 见其文档），pi-pane 不提供绕过已配对设备的重置通道。
- **主代理**：主会话的 pi 进程（无论在终端里还是在 pi-pane 里）同样以当前用户运行，pi-pane 无法区分主代理和用户在磁盘上的操作。
- **程序文件**：Agent 可以修改 pi-pane、插件或浏览器的程序文件。
- 真正的隔离需要让 Agent 以另一个系统用户、在沙箱或虚拟机里运行，不在本项目计划内。

其他剩余风险：

- persistent 横幅保存在 `banners.json`，同一系统用户下的程序同样可以删除或改写它；横幅只防提示被静默丢失，不防故意删除。插件启用时会按自己的状态重新设置横幅。
- 终端里运行的 pi 在 pi-pane 打开同一会话之后才开始写入时检测不到。
- pane-bridge 的 ticket 在同一 pi 进程内可能被其他扩展读到，见“pane-bridge”。

## 插件宿主

- 只加载可信插件：配置文件 `~/.pi/pane/config.json` 的 `plugins` 列表中显式列出的包或路径。
- 插件运行在服务端进程内，和 pi-pane 有相同的系统权限。
- 插件只能提供声明式 UI（树节点、面板内容、动作、表单、通知），不能向浏览器注入脚本。
- 对插件的调用使用合作式异步超时（默认 10 秒），超时或异常不影响主会话，对应位置显示错误；插件里的同步死循环会卡住整个服务端。是否用 worker 隔离插件待定。

详见 [plugin-api.md](plugin-api.md#运行方式与超时)。

## pane-bridge

pane-bridge 是 pi-pane 用 `-e` 加载进每个主会话的 pi 扩展，负责：

- 图片顺序还原（`message_end` 处理器，见 [image-placeholders.md](image-placeholders.md)）；
- 多题表单通道（见 [plugin-api.md](plugin-api.md#主会话里的扩展使用多题表单)）；
- 回报会话切换（`session_before_switch`、`session_shutdown`、`session_start`，见“会话切换”）；
- 项目信任：按服务端下发的决定处理 `project_trust`，进程内切换到新目录时经回连询问，并报告实际的信任状态（见“项目信任”）；
- 会话替换后重新绑定到服务端（见“会话替换后的重绑定”）。

### 回连通道

- 服务端拉起子进程时生成一次性 ticket，经环境变量传入；pane-bridge 第一次加载时读取并兑换成连接凭证，然后从 `process.env` 删除。之后通过 loopback HTTP 与服务端的 `/bridge/*` 接口通信。兑换响应里带着启动配置（如项目信任的决定）。
- 连接凭证绑定到这个托管进程（hostkit 的进程身份）。`/bridge/*` 只能对该进程当前的会话提交表单请求、回报事件、请求信任确认和写锁，这些都是 Agent 级操作，不能访问浏览器使用的 `/api`。进程退出后凭证作废。
- **风险**：在 pane-bridge 删除之前，环境变量对同一进程里先加载的其他扩展可见，它们可以读到并抢先兑换（兑换只能成功一次，pane-bridge 兑换失败时按下一节“会话替换后的重绑定”第 5 步终止该进程）；pane-bridge 删除之前启动的子进程也会继承它。
- **备选（待确认）**：全部经 RPC 的 stdio 通信，不另开 HTTP 通道，就没有环境变量里的 ticket。需要 P0 确认 pi 是否有可以承载双向数据的扩展通道（例如借用扩展 UI 的请求与回应）。

### 会话替换后的重绑定

进程内的 new、resume、fork、clone 和 reload 会拆掉旧的扩展实例、重新实例化扩展；旧实例捕获的 `pi`、`ctx` 在替换后失效（依据：pi `docs/extensions.md` 的“Session replacement lifecycle and footguns”、`dist/core/agent-session-runtime.js`）。pi 以 `moduleCache: false` 加载扩展模块（依据：`dist/core/extensions/loader.js` 第 481–485 行），模块级变量也不能保证保留。此时环境变量里的 ticket 已经删除，新实例不能再兑换。做法：

1. **进程级保存连接**：pane-bridge 第一次兑换后，把连接对象（凭证、服务端地址、启动配置）存在 `globalThis[Symbol.for("pi-pane.bridge")]`。后续实例加载时先查这里，有就复用，不再读环境变量。
2. **实例认证与重绑定**：新实例加载时先用进程级凭证和递增序号认证，服务端立即拒绝旧实例的回连。已认证但未就绪的实例可以协调写锁和查询信任决定，不能接收会话输入。新实例在自己的 `session_start` 里向服务端发送 `bridgeReady`，带上实例序号、当前 `sessionFile` 和 `ctx.isProjectTrusted()`。注意：RPC 模式下的会话替换（new、resume、fork、clone）会触发两次 `session_start`（runtimeHost 替换与 RPC rebind 各一次）。pane-bridge 实例必须做幂等处理，复用同一个就绪 Promise，每实例只绑定一次监听、只发一次 `bridgeReady`；服务端也做幂等接收。服务端只接受序号最大的实例，旧实例之后的请求一律拒绝。旧实例在 `session_shutdown` 里注销自己的监听，不关闭进程级连接。
3. **就绪前不恢复输入**：服务端从收到 `session_shutdown`（含 reload）起暂停该进程的控制队列。初始化在状态和条目读取、旧锁释放及持久化之后复查 stopping 与切换代次，只有仍有效的初始化才能提交重绑定并恢复输入。每次拉起都有独立的启动归属标记，随 handle 迁移；就绪回调显式携带来源 handle，事件和退出回调也核对启动归属，旧写者不能修改后来启动的写者。就绪回调早于 start 返回时同样按来源 handle 绑定。
4. **未就绪即终止**：新会话的 `session_start` 之后在就绪超时（暂定 10 秒）内没有收到 `bridgeReady`，或重绑定失败（如进程级连接对象不存在，新实例不自行申请凭证），服务端立即按 hostkit 的流程终止该 pi 进程（`clear_queue` → `abort` → 终止进程树），把会话标为 `interrupted`。界面以只读方式显示会话内容，提供“重启”，重启时用新 ticket 重新拉起。不让进程在暂停状态下存活，也不提供“不用 pane-bridge 继续”：会话写锁靠 pane-bridge 在 `session_before_switch`、`session_shutdown` 时请求，没有它的进程只要还活着，扩展命令或扩展自己的定时器就能切换会话，目标文件会在没有取锁的情况下被 `SessionManager.open()` 打开（依据：[pi-hostkit 设计文档“取得锁的时机”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#取得锁的时机)的情况 ③、`dist/core/agent-session-runtime.js` 第 129–135 行）。
5. **首次拉起同样处理**：拉起后 pane-bridge 没有在就绪超时内完成兑换并发出 `bridgeReady`（扩展加载失败、ticket 被抢先兑换、回连失败等）时，服务端不向该进程发送任何输入，按第 4 步终止进程，会话显示原因并提供“重启”。若 ticket 被抢先兑换或非法，pi 直接以退出码 1 退出，服务端遇到启动阶段退出码 1 当成 ticket 或启动失败处理，记下诊断，不自动重试。
6. **超时窗口内的替换**：已认证实例在就绪前仍可协调每个目标的写锁。`session_before_switch` 对 new、resume 均检查回连，`session_before_fork` 同样检查；协调不可用时在可取消的事件中返回 `{ cancel: true }`。new/fork 的实际目标路径在 `session_shutdown` 中登记当前 writer 并持锁，直到切换确认或进程停止。未就绪期间不发送 RPC 输入，就绪超时仍终止写者。

`globalThis` 上的连接对象对同一进程里的其他扩展可见，风险与环境变量里的 ticket 相同（见“回连通道”），连接能做的都只是 Agent 级操作。
## 数据目录

默认 `~/.pi/pane/`，可用环境变量 `PI_PANE_HOME` 覆盖。

```text
~/.pi/pane/
  config.json        # 端口、piPath、插件列表、回收时间等
  plugins/<id>/      # 插件专用目录（仅当前用户可访问）；插件可以在这里保存自己的凭证，如 pi-agora 插件连 daemon 的 Agent 级凭证
  assets/            # 输入框上传的图片，见 image-placeholders.md
  cache/blobs/       # 从会话文件中提取的图片缓存，可以随时删除
  tmp/               # 导出等临时文件
  run/               # 本实例托管进程的身份记录（hostkit 的 ProcessIdentity）；会话写锁的共享记录不在这里，在 ~/.pi/hostkit/locks/
  recovery/          # 不完整遗留写者恢复的诊断；保留并阻止自动拉起
  state.json         # 界面状态：打开的会话、侧栏展开状态、已知项目目录
  banners.json       # persistent 横幅（见 plugin-api.md 的“横幅”），写临时文件后原子替换
```

pi-pane 自己不在磁盘上保存访问凭证和对话内容，对话只在 pi 的会话文件里。

## 核心功能范围

MVP 包含：

1. 按项目列出会话（尊重 `sessionDir`），新建、打开、只读查看、关闭会话。
2. 聊天流：Markdown 渲染、思考内容折叠、工具调用卡片（参数和结果）、`edit` 的差异显示、压缩分隔标记、自定义消息卡片。
3. 输入框：发送、steer（运行中追加）、follow-up（排队）、停止；图片占位符；斜杠命令与补全。
4. 模型与 thinking 选择（RPC `get_available_models`、`set_model`、`set_thinking_level`）。
5. 上下文用量和费用显示（RPC `get_session_stats`）。
6. pi 原生扩展 UI：select、confirm、input、editor、notify、setStatus、setWidget（文本）、setTitle、set_editor_text；项目信任询问。
7. 鉴权：配对码、会话凭证、设备密钥与用户在场确认。
8. 插件接口：会话树、面板、动作、表单、通知；子会话的实时流和存档查看。

## 明确不做

- 终端、Git 面板、文件编辑器、canvas、设备中心、审批规则引擎、定时任务。
- 子代理、会议等业务逻辑（由插件提供）。
- 第三方插件的前端代码、插件市场。
- 公网访问、多用户。
- 与外部写者同时写同一会话（多个标签页共享同一托管会话，但不做冲突合并）。
- pi TUI 的自定义组件（`ctx.ui.custom()` 在 RPC 模式下不可用，依据：pi `docs/rpc-extension-ui.md`）。
- 在界面里导航会话树的任意分支（`/tree`）。

## 以后可能做

- 按 loopback 连接查出请求对端的进程，作为审计信息。
- 插件的 worker 隔离（见“插件宿主”）。
