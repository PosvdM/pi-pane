# B 组 P0 验证结果

## 范围与环境

- 验证项：pane roadmap #1、#9，以及 agora roadmap #14。
- 系统：macOS arm64，`uname -srm` 为 `Darwin 27.0.0 arm64`；Node.js `v26.12.0`；pi `1.5.0`。
- pi 安装包：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`。执行使用 `PATH` 中的 pi，扩展由其加载器加载。
- 所有 provider 请求由共用 harness 的 `p0-fake/scripted` 处理。没有调用 Claude、GPT 或 Gemini，没有访问真实模型服务。
- 所有会话、配置、测试密钥、图片和日志均位于临时目录。子进程的 `HOME` 和 `PI_CODING_AGENT_DIR` 由 harness 隔离，没有读取或写入真实用户的 `~/.pi`。
- Windows：待测。Linux：待测。下文的「通过」仅指本轮 macOS 测量范围，不表示已经完成三平台验证。

## 总结

| 验证项 | 结论 | 依据 |
| --- | --- | --- |
| pane #1：图片清单全部通过 | 不通过 | 清单 #5 的 HTML 用户消息渲染将全部图片放在全部文字前，3 次一致。真实模型语义、浏览器交互和负载可接受预算也未完整验证。 |
| pane #9：pane-bridge 通道 | 通过 | 连续 10 次替换后新实例处理图片、表单和锁请求；旧实例返回 409；共享连接仅兑换一次；同进程扩展能读取并使用凭证。stdio input 可承载 JSON 往返。此结论不包含真实写锁互斥或浏览器表单实现。 |
| agora #14：launch ticket | 通过 | 删除扩展排首位时后续扩展、MCP、bash 均看不到 ticket；即使 `builtin:mcp` 排在删除扩展前，MCP 进程也在删除后启动。删除前的其他扩展能读到 ticket。 |

重跑命令：

```sh
node --test --test-reporter=tap experiments/p0/b-bridge/*.test.mjs
```

[run.tap](run.tap) 的末尾为：

```text
# tests 18
# pass 15
# fail 0
# skipped 3
# duration_ms 39496.896708
```

测试断言包含已知的不符行为，所以退出码为 0 不表示设计全部通过。补充角色/时间戳、独立 nonce 校验和非 user 消息范围测试后的最终完整重跑见 [verification.tap](verification.tap)：19 项、16 通过、0 失败、3 跳过，耗时 44.3 秒。下文资源数值引用 `run.tap` 的一轮，不是多轮平均值。

## 图片顺序：pane #1

### 方法与判定范围

`images.mjs` 生成红色方块、蓝色圆形、白底黑色字母 C 三张合法 PNG。大小分别为 89、149、98 字节；图片内容不同，测试逐字节比较图片数据，不以图片大小代替身份比较。

服务端原型生成含独立 nonce 的 `⟦pane-img:<nonce>:<k>⟧` 字符串和图片数组。`bridge.ts` 只替换 `role: user` 的消息，并保留角色和时间戳。它在 `message_end` 中刻意等待 35 毫秒后返回替换，以检测 provider 请求是否等待处理器完成。

普通发送、steer、follow-up 的每次实验同时比较四个位置：RPC `message_end`、`get_entries`、磁盘 JSONL 和 provider 实际收到的用户内容。恢复实验另起 pi 进程。压缩调用真实 pi 的手动和自动压缩路径，摘要回复仍来自假 provider。

清单要求真实模型按编号描述图片。本轮禁止真实模型调用，因此不能把假 provider 的固定回复当作图片识别证据；涉及语义识别的场景只验证结构部分。清单 #7 的「macOS 上无法验证」表示本轮 macOS 实验因真实模型限制跳过，不表示这些模型不支持 macOS。

### 清单逐项结果

| # | 验证内容与通过标准 | 实测结果与关键日志摘录 | 结论 |
| --- | --- | --- | --- |
| 1 | 普通 `prompt`：模型描述正确，文件 content 交错。 | 3 次，provider/RPC/entries/磁盘均为 `T红,I红,T蓝,I蓝,TC,IC,T尾`。`prompt repetition:1 content:["T:红方块[Image #1]","I:89",…,"T:结束"]`。真实模型描述未测。 | 部分通过 |
| 2 | 运行中 steer：送达消息还原，队列正常出队。 | 3 次，运行中的假请求延迟 500 ms 后继续。每次 2 个 `queue_update`，第一个含标记，最后一个不含标记；provider 和持久化均交错。`steer repetition:1 queueUpdates:2`。真实模型描述未测。 | 部分通过 |
| 3 | follow-up：送达消息还原，队列正常出队。 | 3 次，`follow_up repetition:1 queueUpdates:2`；顺序和图片字节在四个位置一致。真实模型描述未测。 | 部分通过 |
| 4 | 关闭并恢复后，模型仍能按编号引用历史图片。 | 3 次，停止 pi 后用相同 `--session` 文件和新 ticket 重启，再发文字。provider 上下文中的第一条用户消息与恢复前逐字节一致。`resume repetition:1 preserved:["T:段1[Image #1]","I:89",…]`。模型引用是否正确未测。 | 部分通过 |
| 5 | `export_html` 按交错顺序显示。 | 3 次，导出内嵌数据保持交错，但执行导出 HTML 自带的用户渲染分支得到 `I1,I2,I3,T1+T2+T3+tail`。第一张图片偏移 74，第一段文字偏移 736。 | 不通过 |
| 6 | 手动和自动压缩不报错，压缩后可继续。 | 各 3 次，手动 `compact` 返回 success，自动产生带 result 的 `compaction_end`，每次新增 1 条 compaction，随后普通输入完成。完整历史里的图片消息仍可由 `get_entries` 读取。`compact automatic:false requests:4`；`automatic:true requests:5`。 | 通过 |
| 7 | Claude、GPT Sol、GPT Astra、Gemini 各通过普通发送。 | 测试明确 skip：`需要真模型；本实验只允许假 provider，不发网络请求`。没有把同一假 provider 改名成四个模型。 | macOS 上无法验证 |
| 8 | `message_end` 处理完成后才开始本轮模型请求，替换只作用于 user。 | prompt、steer、follow-up 各 3 次，等待 35 ms 后返回替换，provider 已收到交错内容。例如 `restoreAt:1793856956832,providerAt:1793856956834`；有同一毫秒的记录，但内容断言仍确认已替换。另测 assistant 两条、真实 read 工具结果一条中的相同标记保持原样：`userReplacements:1,unchangedAssistantMessages:2,unchangedToolResults:1,warnings:0`。 | 通过 |
| 9 | 开启 `images.autoResize` 后顺序和对应关系不变。 | 3 次，小图逐字节不变。2100×24 和 24×2100 两图变为 2000×23 与 23×2000，mime 分别为 PNG、JPEG。独立调用 pi 公开的 `resizeImage()` 得到参考结果，provider 图片按位置的 SHA-256 与参考一致。`referenceHashOrderMatches:true`。 | 通过 |
| 10 | 纯图片、相邻两图、10 图、相似手写标记的边界。 | 每种 3 次，provider 与持久化内容符合预期。普通手写 `[Image #1]`、格式不匹配的 `⟦pane-img:short:1⟧` 保留为文字。无效数量/nonce/编号消息只产生「图片顺序未还原」警告，不替换。图片语义描述未测。 | 部分通过 |
| 11 | 无 bridge 还原的备用编码仍能按编号对应。 | 3 次，发送 `[Image #k]` 文字加图片尾数组，provider 收到 `T,I1,I2,I3`，图片字节及编号顺序一致。真实模型按编号理解未测。 | 部分通过 |
| 12 | 10 图、合计刚好不超过 12 MiB：发送成功、两种读取正常，记录单行/响应时间/内存并评估是否可接受。 | 同一会话连续发送 3 条，每条恰好 12,582,912 解码字节，均完成；最大 JSONL 行 16,778,325 字节。pi `get_entries` 和本实验只读 JSONL 解析均成功。生产 pane 解析器不存在，文档没有给出可接受预算。详见负载表。 | 部分通过 |
| 13 | 单张 >4 MiB、11 张、合计 >12 MiB：浏览器和服务端均拒绝，且不发给 pi。 | 三类各 3 次。共享校验函数返回对应中文原因，绕过函数直接 HTTP POST 到原型端点返回 413，provider 请求数未增加。实际浏览器上传、缩放后的 UI 提示未测。 | 部分通过 |
| 14 | 停止时取回两条带图片 steer，草稿和顺序不变。 | 3 次，先 `clear_queue` 再 `abort`；RPC 只返回 `steering`、`followUp` 文本。用原型保存的 nonce/编码文本→草稿映射恢复两条各 3 图的原草稿，图片顺序和字节一致，之后未产生这些输入的 provider 请求。浏览器输入框交互未测。 | 部分通过 |

### 导出观察

关键日志：

```json
{
  "observation": "export",
  "repetition": 1,
  "embedded": ["T:段1[Image #1]", "I:89", "T:段2[Image #2]", "I:149", "T:段3[Image #3]", "I:98", "T:末尾"],
  "rendered": "I1,I2,I3,T1+T2+T3+tail",
  "firstImageOffset": 74,
  "firstTextOffset": 736,
  "designPass": false
}
```

本实验执行了导出文件中原始 `renderEntry()` 的 user 分支，只对时间、复制按钮和 Markdown 函数提供 stub；没有重新实现图片排列逻辑。没有操作浏览器或使用截图。提取结果见 [export-order.html](export-order.html)。

源码对应 `dist/core/export-html/template.js` 的 `renderEntry()`：用户文本先被合并，图片被 `content.filter(c => c.type === 'image')` 收集，渲染完所有图片后才渲染文字。交错的会话数据没有丢失，但导出视图不保留交错位置。

与设计不符的位置是本仓 `docs/image-placeholders.md`「P0 验证清单」第 5 项，以及 `docs/roadmap.md`「P0 验证项」第 1 项要求清单全部通过的标准。它不构成 `message_end` 替换时机失败的证据：该替换在发送和持久化中确实生效。本实验没有修改设计或实现补救路径。

### 12 MiB 负载

合法负载包含三张接近 4 MiB 的 PNG，以及七张小图。大图使用合法 PNG `tEXt` 块补足大小，不是高分辨率照片；本实验关闭 pi 自动缩放，以直接观察合法字节上限的传输和 JSONL 成本。

| 连续消息 | 解码图片字节 | 最大 JSONL 行字节 | 发送至 settled | `get_entries` | 只读全文件 JSONL 解析 | 驱动采样最高 RSS | pi 命令结束后 RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 12,582,912 | 16,778,325 | 2781.8 ms | 641.6 ms | 37.2 ms | 846,631,432 B | 617,401,640 B |
| 2 | 12,582,912 | 16,778,325 | 2950.6 ms | 2587.9 ms | 74.8 ms | 1,768,715,712 B | 702,879,704 B |
| 3 | 12,582,912 | 16,778,325 | 3129.5 ms | 5349.2 ms | 109.6 ms | 1,750,113,760 B | 784,178,144 B |

驱动进程包含测试、HTTP 原型、harness 事件缓存及完整 provider 请求副本。harness 会保留完整 `get_entries` 响应和含全部历史的 provider 请求，因此此处 RSS 不能直接当作生产 pane 服务端内存预算。采样每 10 ms 一次，只给出采样到的最高值，不保证覆盖同步分配瞬间的峰值。pi RSS 来自扩展调用 `process.memoryUsage()`，也不是 pi 峰值。

`get_entries` 随完整历史增长的耗时、图像内容代表性、浏览器处理能力和生产只读解析均没有冻结的验收阈值，所以本项没有判为通过。没有据此修改文档中的上限。

### 停止返回的数据

```json
{
  "observation": "clear-images",
  "returnedFields": ["steering", "followUp"],
  "imagesInRpc": false,
  "draftLookupImages": [3, 3]
}
```

`clear_queue` 本身没有返还图片数据。本实验取回图片依赖发送前保存的草稿映射，符合 `docs/architecture.md`「steer 与 follow-up 的送达」中按原编码文字关联草稿的理解；没有把 RPC 文本响应表述成图片被 RPC 返回。

## pane-bridge：pane #9

### 验证内容和通过标准

验证 `pi.events` 表单往返、ticket 在同进程扩展中的可见范围、删除后的子进程环境，以及 new/resume/fork/clone/reload 后连接复用、实例 fencing、输入门禁。每次替换后，图片、表单和写锁回报必须由当前实例处理；旧实例不能被服务端接受。

「锁请求」在本组解释为 pane-bridge 的请求确实到达回连服务端，不包含系统文件锁、跨宿主互斥或杀进程恢复。HTTP 服务返回固定表单答案，验证事件总线和回连，不代表浏览器表单已实现。

### 实测结果

1. 第一次工厂读取并删除 ticket，以 loopback HTTP 兑换凭证，保存在 `globalThis[Symbol.for('pi-pane.bridge')]`。
2. 执行两组 new、resume、fork、clone、reload，共 10 次替换。第一组使用 RPC，reload 通过扩展命令；第二组使用扩展命令，clone 对当前 leaf 调用 `ctx.fork(..., { position: 'at' })`。
3. 工厂总共运行 11 次，实例号从 1 到 11。服务端只看到 1 次兑换。后续工厂的 `ticketVisible` 均为 false。
4. 每次新实例处理图像还原及 `pane:form:request` → HTTP → `pane:form:response`。答案为 `{ pick: 'B' }`。通过 `pane:ping` 同步取得 `pane:pong`。
5. 从全局连接对象里保存的旧实例 `call()` 闭包实际发请求，均收到 `409 stale_instance`。测试另用旧序号直接发请求，也收到 409。
6. 8 次 new/resume/fork/clone 的前置锁回报，以及各次 shutdown 的目标路径回报，均经回连成功。reload 没有额外伪造前置锁请求。
7. shutdown 后、bridgeReady 前的 10 次提交均被原型输入门禁拒绝，provider 从未收到 `BLOCK_BEFORE_READY`。首次启动未 ready 时也拒绝提交。
8. 同进程里排在 bridge 之后的另一个扩展能读取全局连接的地址、凭证和实例号，并以当前序号成功调用回连接口，返回 200。排在 bridge 前的扩展工厂能看到 ticket。删除后，普通 Node 子进程和模型调用的真实 `bash` 工具子进程均看不到 pane ticket。
9. 重放已兑换的 ticket 返回 403。以这种 ticket 启动 bridge 时，工厂抛错，pi 直接以 code=1 退出，尚未响应 `get_state`，provider 请求为 0。

关键日志：

```json
{"observation":"replacement","repeat":1,"type":"reload","instance":11,"staleStatus":409,"formInstance":11,"peerCredentialUse":200}
{"observation":"bridge-scope","factories":11,"child":{"pane":false,"agora":false},"blockedBeforeReady":10,"locks":8,"launches":1}
{"observation":"stdio-and-ticket","earlyPeerTicket":true,"replayStatus":403,"requestMethod":"input","response":{"answers":["A","B"]}}
{"observation":"ticket-rejected","launches":[200,403],"providerRequests":0,"ready":false,"startupExitCode":1}
```

结论：通过。

### stdio 备选的实测范围

扩展使用 `ctx.ui.input()` 将两题 JSON 放入 title，驱动通过匹配 id 的 `extension_ui_response.value` 回送 JSON，扩展解析到 `{ answers: ['A', 'B'] }`。这条往返没有另外使用 ticket。

pi 1.5.0 的 RPC 文档提供 select/confirm/input/editor 四种对话框，没有独立的任意 JSON 扩展 RPC 消息类型；`ctx.ui.custom()` 在 RPC 模式返回 undefined。实验证明 input 可以传输字符串形式的双向 JSON，没有验证完整多题前端、并发表单、取消、超时或写锁请求全部改走 stdio。这里只记录能力边界，不作通道选型决定。

### 启动故障的原始现场

首次故障实验原本预期「pi 已响应 `get_state`，但 bridge 不就绪」。实际 pi 在显式扩展加载失败时直接退出：

```text
pi closed: {"code":1,"signal":null}
Failed to load extension: bridge ticket rejected
Hint: Start without extensions using "pi -ne".
```

原始失败输出保存在 [startup-observation.tap](startup-observation.tap)，现场为 `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-KXvyZQ`。已报告这一观察，没有修改 pi；可重跑脚本按实际 code=1 行为断言。该差异没有使未经就绪的输入发出。

## launch ticket：agora #14

### 验证内容和通过标准

`AGORA_LAUNCH_TICKET` 在 agora 扩展工厂同步删除后，真实 bash 工具的子进程应看不到它。记录白名单扩展工厂和 `builtin:mcp` 的实际先后与可见范围。

本实验的 MCP 配置只写入临时 agent 目录的 `mcp.json`，使用本目录的无依赖 stdio MCP 服务器。它实现 initialize、tools/list、tools/call，声明并实际调用 `mcp__local__ping`，没有远程服务器或网络请求。

### 实测结果

| 扩展参数顺序（假 provider 始终在前） | 另一个扩展工厂看到 ticket | MCP 进程看到 ticket | bash 子进程看到 ticket |
| --- | --- | --- | --- |
| 删除扩展 → 另一个扩展 → `builtin:mcp` | 否 | 否 | 否 |
| `builtin:mcp` → 另一个扩展 → 删除扩展 | 是 | 否 | 否 |

首位删除的日志：

```json
{"at":1793856994580,"kind":"agora-delete","visible":true}
{"at":1793856994589,"kind":"peer-factory","agoraTicket":false}
{"at":1793856994717,"kind":"mcp","pid":50136,"action":"start","agoraTicket":false,"paneTicket":false}
```

将 `builtin:mcp` 放在删除扩展前的日志：

```json
{"at":1793856995293,"kind":"peer-factory","agoraTicket":true}
{"at":1793856995295,"kind":"agora-delete","visible":true}
{"at":1793856995424,"kind":"mcp","pid":50151,"action":"start","agoraTicket":false,"paneTicket":false}
```

两组 `bash` 实际执行的 Node 环境探针均输出 `{"ticket":false}`。MCP 工具在 provider 工具声明中出现，服务器收到 `tools/call`，避免把未连接服务器误判成「未继承环境」。

源码核对：`dist/core/extensions/loader.js` 的 `loadExtensionsInternal()` 按 paths 顺序逐个 await 加载；`initializeExtension()` await 工厂完成。实测工厂顺序与此一致。MCP 在本轮两种顺序下都在同步删除之后才启动，未观察到它提前继承 ticket。

对应文档是 agora `docs/security.md`「磁盘凭证与连接 token → 协作会话」和 `docs/roadmap.md` 第 14 项。环境变量只对删除之后启动的子进程消失；删除前的同进程代码可读取它，本轮没有证明 ticket 对任意白名单扩展不可见。

结论：通过。

## harness、现场与清理

### harness 使用情况

没有修改 harness，也没有发现阻碍本组验证的 harness 错误。以下是测量限制：

- 默认关闭 `images.autoResize`；本组对缩放场景显式开启，对 12 MiB 原始字节负载显式保留关闭。
- 事件和完整历史请求缓存在驱动内存中，多条大图消息使测试驱动 RSS 增长。报告没有将其混同于生产服务端内存。
- `promptAndWait()` 只适合顺序回合；运行中 steer/follow-up 使用 cursor 和 `agent_settled` 等待，不把任意一次 settled 当作并发输入的逐条确认。
- MCP 进程可能拥有独立进程组；pi 自身关闭服务器后，测试按记录的 MCP PID 检查存活状态。没有按进程名称终止任何进程。

### 保留现场

以下目录保留数据，所有其中启动的进程均已停止：

- `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-ddkNFK`：最终 19 项完整重跑的导出不符现场。
- `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-FdG3ib`：补充断言过程中的前一轮导出不符现场。
- `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-iuFdTu`：报告所用导出不符现场，含原始导出 HTML、渲染片段、JSONL 和 provider 请求。
- `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-E7PiLe`：补充覆盖时同一导出不符的前一轮现场。
- `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-KXvyZQ`：最初启动故障实验的原始失败现场。

普通成功现场已删除。以后重跑也会保留导出不符现场；`B_KEEP=1` 可保留其他成功现场。

### 进程结果

测试结束时已调用 harness `stop()` 终止自己启动的 pi 进程组，等待退出后关闭自己启动的 HTTP 服务。正常停止日志的 pi 退出码为 143；故障注入启动退出码为 1。MCP PID 50136、50151 在停止后均不存在：`mcp-cleanup remaining:0`。真实 bash 工具已完成，未启动后台任务。

额外对各轮日志累计记录的 81 个 pi/MCP PID 执行存活检查，没有返回存活行，见 [process-audit.txt](process-audit.txt)。没有遗留进程。未使用 `pkill`、`killall` 或按名字终止；未修改全局安装；未推送或创建 PR。

只更新了本实验目录的说明、结果和证据；`docs/` 仍保持设计草案原文，符合本组边界。
