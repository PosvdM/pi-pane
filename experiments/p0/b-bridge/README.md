# B 组 P0 实验

验证图片顺序还原、pane-bridge 回连与重绑定，以及 agora launch ticket 的可见范围。结果见 [RESULTS.md](RESULTS.md)。

## 运行

在仓库根目录执行：

```sh
node experiments/p0/b-bridge/run.mjs
```

需要 Node.js 24 及以上、`PATH` 中的 pi 1.5.0，以及相邻的 `../harness/`。本轮使用 macOS arm64、Node.js 26.12.0。无需安装依赖，不访问真实模型服务。

默认将 TAP 和进程审计保存到每次独立命名的系统临时目录，并在结尾打印路径；不会改写已提交证据。显式刷新仓库里的验证日志、进程审计和导出片段：

```sh
P0_RECORD=1 node experiments/p0/b-bridge/run.mjs
```

筛选定向测试时可追加 Node 测试参数，例如 `node experiments/p0/b-bridge/run.mjs --test-name-pattern='pane #9：new'`。也可直接用 `node --test experiments/p0/b-bridge/*.test.mjs` 运行断言；这些测试同样只在临时现场写入日志，除非显式设置 `P0_RECORD=1`。

测试创建临时 `HOME`、`PI_CODING_AGENT_DIR`、工作目录和会话目录。回连 HTTP 仅监听随机的 `127.0.0.1` 端口；MCP 是本地 stdio 子进程。测试不读取真实用户的 pi 配置。

## 文件

| 文件 | 用途 |
| --- | --- |
| `run.mjs` | 独立临时输出目录、测试驱动、记录开关和进程审计。 |
| `experiment.mjs` | 本组的停止防护，避免共用 harness 对已退出 child 重复发信号。 |
| `stop.test.mjs` | 已退出、并发和重复停止的单元断言。 |
| `bridge.test.mjs` | 图片清单、barrier 同步、连续会话替换及唯一 requestId 的 1/1/1 表单验收。 |
| `failure.test.mjs` | ticket 重放导致启动失败的故障注入。 |
| `scope.test.mjs` | 只还原 user，保留 assistant 和真实 read 工具结果中的标记。 |
| `bridge.ts` | 最小 pane-bridge 扩展：兑换、`globalThis` 连接复用、实例号、图片还原、表单和写锁请求。 |
| `server.mjs` | 回连原型：一次性 ticket、实例 fencing、输入就绪门禁和表单应答；另有图片大小校验测试端点。 |
| `peer.ts` | 第二个扩展：事件总线、全局连接可见性、旧实例调用、stdio JSON 和会话替换命令。 |
| `agora-first.ts` | 在扩展工厂中同步读取并删除测试 ticket。 |
| `fake-mcp.mjs` | 无依赖 stdio MCP 服务器，记录启动环境和协议方法。 |
| `images.mjs` | 合法 PNG 生成器、图片标记编码/还原和大小校验。 |
| `run.tap` | 历史图片与资源测量，不覆盖重复 start 的幂等验收。 |
| `verification.tap` | 显式记录的当前完整重跑，含 barrier、重复 start 和严格计数。 |
| `process-audit.txt` | 当前记录运行的已记录 pi/MCP PID 存活检查。 |
| `startup-observation.tap` | 首次启动故障实验的原始输出；保留当时错误的测试预期及 pi 的实际退出信息。 |
| `export-order.html` | 从实际导出的用户渲染分支得到的 HTML 片段；展示图片集中排在文字之前。 |

同一实例可能收到两次 `session_start`，监听绑定和就绪报告必须幂等。时序测试使用 provider 和还原处理器的显式 release barrier；表单计数在等待所有已发起处理 Promise 完成后检查，不靠固定延时截取回应。

`server.mjs` 不实现生产鉴权、真实文件锁、浏览器上传或浏览器表单。它用于验证 pi 提供的生命周期和通道，不是可部署的 pane 服务端。

## 断言与 P0 结论

测试同时断言正常行为和已观测到的不符行为。例如，导出实验断言实际渲染为“全部图片、全部文字”。因此测试进程退出码为 0 不等于 P0 全部通过；逐项结论以 `RESULTS.md` 为准。

普通成功现场会被删除，汇总 TAP 和审计保留在每次独立的临时输出目录。导出不符现场始终保留；失败现场也保留，路径显示在 `fixture:` 日志中。设置 `B_KEEP=1` 可保留全部现场。保留的目录只有日志和数据，测试仍会停止自己启动的进程并关闭 HTTP 服务。

图片的真实模型语义识别、尚无实现的浏览器交互、Windows 和 Linux 分别以测试 skip 明确列出。跨平台脚本入口不包含本机绝对路径；Windows、Linux 的实际运行结果待测。
