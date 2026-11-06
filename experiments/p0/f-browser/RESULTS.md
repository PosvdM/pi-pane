# P0 F 组：浏览器与鉴权

本组验证 pi-pane roadmap 的 #11、#12、#14 和 pi-agora roadmap 的 #16。实验不涉及 pi 进程，没有使用 `experiments/p0/harness/`。

浏览器范围：主人已决定目前只考虑 Chrome。Edge、Firefox、Safari 不在本组范围内，不列为缺口；Playwright 下载的 WebKit 构建只作可选参考（`P0_BROWSERS=chrome,webkit`），不计入结论。

## 结论

| 项 | 结论 | 说明 |
| --- | --- | --- |
| pane #11 鉴权 | macOS/Chrome 鉴权原型通过 | 审查发现上一版鉴权原型有两处缺陷：WebSocket 首帧被拒后连接不是终态，后续帧仍会被处理；24 小时空闲过期只在 HTTP 上检查。返工已修复，新增的反例和空闲过期测试在 macOS/Chrome 上全部通过（见“修复与复测”），复审已确认修复。不发帧的连接最多在过期后约一个 `sweep()` 间隔（默认 60 秒）才关闭；5 秒首帧超时的真实墙钟时延只记录、不作硬预算。这只是原型结论，不代表生产实现已验收。Windows、Linux 待测 |
| pane #12 设备密钥与签名 | 通过（macOS/Chrome） | Chrome 普通窗口和无痕上下文都能生成不可导出的密钥、存入 IndexedDB、签名并在 Node.js 中验签；非安全上下文返回 `unsupported`。Windows、Linux 待测 |
| pane #14 前端打包体积 | 通过 | Vite + Preact + markdown-it + highlight.js（common 语言集）gzip 后 97.9 KiB；构建产物在设计的 CSP 下用 Chrome 运行，没有违规 |
| agora #16 设备签名验签 | 通过 | 验签原型按 security.md 的 1–6 步实现；Chrome 生成的合法签名通过，其余 17 次提交（重放、过期、参数被改、公钥不符等）全部被拒。Windows、Linux 待测 |

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS 27.0.1（26A434），Apple Silicon |
| Node.js | v26.12.0 |
| 浏览器 | 本机 Google Chrome 156.0.8078.80，由 playwright-core 1.64.1 以 `channel: "chrome"`、headless、临时配置目录驱动 |
| 前端依赖 | vite 8.3.5、preact 11.1.1、@preact/preset-vite 2.10.6、markdown-it 15.0.3、highlight.js 11.12.0 |

## 重跑

在 `experiments/p0/f-browser/` 下执行：

```sh
npm install          # 安装到本目录的 node_modules
npm test             # node --test test/*.test.mjs，默认只跑 Chrome
```

- 不装依赖也能跑的部分：`node --test test/11-auth-server.test.mjs test/16-verifier-node.test.mjs`（只用 Node.js 内置模块）。
- 加跑 WebKit 参考：先 `npm run browsers`（下载到本目录的 `.browsers/`），再 `P0_BROWSERS=chrome,webkit npm test`。
- 手动试用鉴权原型：`node lib/auth-server.mjs 4319`，终端打印带配对码的地址，按 Enter 生成新配对码。

证据文件：

- 每个测试文件把 `note()` 记录的观察写成 JSON。默认写到被忽略的 `.evidence/<测试文件>-<时间>-<PID>.json`，每次运行文件名不同。
- 只有设置 `P0_RECORD=1` 时才刷新已提交的 `evidence/<测试文件>.json`。本文的日志摘录来自 `evidence/`，由 `P0_RECORD=1 npm test` 生成。
- #14 的构建产物写到系统临时目录下每次不同的 `p0-f-bundle-*`，测试结束时删除。

最近一次 `npm test` 的输出摘要：

```text
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ skipped 0
```

## 文件

| 路径 | 内容 |
| --- | --- |
| `lib/auth-server.mjs` | pane #11 鉴权原型服务端：Host/Origin 检查、配对码、Bearer 凭证、ws-ticket、WebSocket 首帧鉴权与连接状态机、安全响应头 |
| `lib/ws.mjs` | 零依赖的最小 WebSocket 实现（服务端握手、文本帧、close），带 open/closing/closed 状态 |
| `lib/plain-server.mjs` | 不做任何检查的静态服务器，模拟“同机其他 `127.0.0.1` 端口”，也用于非安全上下文 |
| `lib/confirm-verifier.mjs` | agora #16 验签原型：待确认、挑战、按 security.md 的 1–6 步验签 |
| `lib/browsers.mjs` | 浏览器驱动（playwright-core）：本机 Chrome，WebKit 可选 |
| `public/` | 浏览器端原型：`app.js`（配对、`sessionStorage`、`BroadcastChannel`、WebSocket）、`device-key.js`（设备密钥与签名）、`jcs.js`（RFC 8785，浏览器与 Node.js 共用）、`jcs-vectors.js`（RFC 8785 测试数据） |
| `evil/` | 其他端口上的攻击页面 |
| `bundle/` | pane #14 的 Vite + Preact 骨架 |
| `scripts/install-browsers.mjs` | `npm run browsers` 的实现：把 Playwright 的 WebKit 下载到本目录 |
| `test/` | `node --test` 测试；`helpers.mjs` 提供条件等待、可控时钟和证据记录 |
| `evidence/` | 用 `P0_RECORD=1` 记录的一次观测 |

## pane #11 鉴权

### 验证内容

按 [architecture.md](../../../docs/architecture.md#鉴权) 写一个最小原型（`lib/auth-server.mjs`、`public/app.js`），覆盖：

- 配对码换会话凭证：地址 `/#code=<配对码>`，兑换后用 `history.replaceState` 移除；配对码一次性、10 分钟过期、连续输错 5 次作废；也可手动输入。
- 只服务规范源：`Host` 必须正好是 `127.0.0.1:<port>`，`localhost` 和其他域名都拒绝；带 `Origin` 时必须是规范源；不开放 CORS。
- 会话凭证只在内存和 `sessionStorage`，用 `Authorization: Bearer` 发送；24 小时无活动失效（HTTP 和 WebSocket 同一规则）；退出登录立即吊销；服务端重启后全部失效。
- 新标签页经同源 `BroadcastChannel` 按 `instanceId` 取得凭证；退出登录时广播 `logout`；服务端重启后旧标签页不交出失效凭证。
- WebSocket：先 `POST /api/ws-ticket` 取 30 秒一次性 ticket，首帧 `{ "type": "auth", "ticket": "…" }`，5 秒内没有有效首帧即关闭；首帧前不推送；鉴权后先发 `banners`；首帧被拒后不再处理任何帧；吊销或空闲过期时关闭连接。
- 所有响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和 CSP；没有 `Set-Cookie`。
- 同机其他 `127.0.0.1` 端口的页面尝试调用接口：CORS 读取、no-cors 读取、简单请求 POST 猜配对码、带 `Authorization` 的预检请求、WebSocket、同名 `BroadcastChannel`、`window.open` 后读 `sessionStorage`。

### 通过标准

全部按设计；同机其他 `127.0.0.1` 端口的页面无法调用 pi-pane 接口。

### 修复与复测

审查（报告第 5、8 条）指出的问题和本轮的处理：

| 问题 | 上一版的行为 | 本轮的修改 |
| --- | --- | --- |
| 首帧被拒不是终态 | 非法首帧后只发 close 帧，`authed` 仍为 false；连接层收帧循环继续分发，`send()` 只检查底层是否已断开。同一批数据里紧跟的合法 auth 可能被接受并收到 `banners` | 服务端每条连接有 `pending`/`authed`/`rejected`/`closing` 四种状态，`rejected` 和 `closing` 是终态：不分发任何帧，`sendTo()` 只在 `authed` 时发送。`lib/ws.mjs` 增加 `open`/`closing`/`closed` 状态：发出 close 帧后丢弃收到的数据帧，`send()` 只在 `open` 时写出 |
| 空闲过期只在 HTTP 上检查 | `bearer()` 检查 24 小时空闲；WebSocket 首帧只看凭证是否存在，已建立连接上的业务帧既不检查也不更新活动时间 | HTTP 请求、WebSocket 首帧、已鉴权连接的业务帧都走同一个 `useCredential()`：过期则吊销，有效则记为活动。另加 `sweep()`（默认每 60 秒）吊销空闲过期的凭证并关闭它们的连接 |
| 5 秒首帧超时用真实墙钟断言 | 负载高时测到 13326 ms 才关闭，超过断言的 6500 ms | 定时器可注入。逻辑测试用可控时钟：推进 4999 ms 时连接仍是 `pending`，再推进 1 ms 变为 `rejected` 并以 4401 关闭。真实墙钟另跑一个测试，只断言最终以 4401 关闭，时延写入证据，不作硬断言 |
| `sleep` 后直接读回应数组 | 服务端测试 `sleep(100)` 后读 `messages[0]`；浏览器测试 `sleep(300)`、`sleep(500)` 后读状态 | 全部改为条件等待并设截止时间。`evil.js` 中等待弹窗的固定 1500 ms 改为条件等待它导航到 pi-pane |

复测结果（`evidence/11-auth-server.test.json`）：

```text
[ws-reject-terminal] {"same-write":{"close":{"code":4401,"reason":"bad_first_frame"},"received":0,
  "clientDroppedAfterClose":0,"serverState":"rejected","auth":"bad_first_frame","ignoredFrames":2,
  "ignoredByAuthLayer":0,"ignoredByConnectionLayer":2,"sendBlocked":0,"ticketStillUsable":true},
  "separate-writes":{...同上...}}
[idle-ticket-valid-credential-expired] {"close":{"code":4401,"reason":"credential_idle_expired"},"received":0,"httpAfter":401}
[idle-after-connect] {"httpAfterWsActivity":200,"pongs":[1,2],"close":{"code":4403,"reason":"revoked:idle"},
  "pongsAfter":[1,2],"httpAfterExpiry":401}
[idle-sweep] {"swept":1,"close":{"code":4403,"reason":"revoked:idle"},"http":401}
[ws-timeout-virtual] {"at4999":["pending"],"at5000":["rejected"],"close":{"code":4401,"reason":"auth timeout"},"received":0}
[ws-timeout-wallclock] {"code":4401,"reason":"auth timeout","ms":5001,"configuredMs":5000,"lateByMs":1}
```

- **拒绝是终态**：非法首帧后紧跟合法 auth 和 ping，分别用同一次 TCP 写入和分三次写入发送。两种情况都只以 4401 `bad_first_frame` 关闭，客户端没有收到 `banners` 或 `pong`，close 帧之后线路上也没有任何数据帧（`clientDroppedAfterClose: 0`）。服务端丢弃了后两帧；那张合法 ticket 之后在新连接上仍能完成鉴权，说明第二帧从未进入鉴权逻辑。实际丢弃发生在连接层（`ignoredByConnectionLayer: 2`）：服务端在处理第一帧时同步发出 close，连接层随即进入 `closing`。
- **测试能发现原缺陷**：手动把服务端和 `lib/ws.mjs` 临时改回上一版的行为（拒绝后继续处理首帧、`send()` 不看状态、连接层照常分发）后，这个测试失败；改回后通过。这次检查是手动做的，不在测试套件里。
- **ticket 有效、凭证已空闲过期**：`idleMs` 缩短为 10 秒（比 ticket 的 30 秒短）。取 ticket 后可控时钟前进 10.001 秒，首帧以 4401 `credential_idle_expired` 被拒，HTTP 也返回 401。默认的 24 小时空闲期远长于 30 秒 ticket，而取 ticket 本身算一次活动，所以默认配置下不会出现这种组合；测试验证的是两条路径用同一规则。
- **连接建立后空闲过期**：鉴权后第 6 秒发 ping 得到 pong；第 12 秒 HTTP `whoami` 返回 200（距鉴权已 12 秒，说明 WebSocket 业务帧更新了活动时间）；第 18 秒再 ping 得到 pong（HTTP 活动同样计入）。之后空闲 10.001 秒再发 ping：没有 pong，连接以 4403 `revoked:idle` 关闭，HTTP 401。
- **没有任何帧时**：空闲恰好 10 秒时 `sweep()` 不吊销；10.001 秒时吊销 1 个凭证，连接以 4403 `revoked:idle` 关闭。
- **稳定性**：同时并发运行 6 份 `11-auth-server.test.mjs`，6 份全部通过；真实墙钟超时的时延为 1–9 ms。

### 其余实测结果

**服务端（`test/11-auth-server.test.mjs`，Node.js 直接发请求，可以伪造浏览器发不出的头）**：14 个测试全部通过。

```text
[host-matrix] 127.0.0.1:<port> → 200；localhost:<port>、LOCALHOST:<port>、localhost.:<port>、127.0.0.1（无端口）、
              127.0.0.1:<port+1>、evil.test:<port>、[::1]:<port>、127.1:<port>、2130706433:<port>、空 Host → 403
[origin-matrix] 规范源 → 200；http://127.0.0.1:<port+1>、http://localhost:<port>、https://127.0.0.1:<port>、
                null、http://127.0.0.1:<port>/ → 403；跨源 OPTIONS 预检 → 403
[code-format] 20 hex chars = 80 bits
[ws-handshake] {"canonical":101,"no-origin":101,"other-port-origin":403,"localhost-host":403,
                "localhost-host-canonical-origin":403,"null-origin":403}
[ws-close-codes] 重用 ticket → 4401 unknown_ticket；首帧不是 auth → 4401 bad_first_frame；
                 过期 ticket → 4401 expired_ticket；退出登录 → 4403 revoked:logout
[restart] 旧凭证 → 401，响应体 {"error":"unauthorized","instanceId":<新 instanceId>}
```

其他检查：配对码重用、过期（时钟前进 10 分钟 + 1 毫秒）、输错 5 次后作废，输错 4 次后仍可用；`Cookie` 头和 URL 参数里的凭证都不被接受；ticket 放在 URL 里不起作用，仍要首帧；鉴权后第一条消息是 `banners`（TCP 按序到达，服务端若在首帧前发过数据，第一条就不会是 `banners`）；所有响应都没有 `Set-Cookie` 和 `Access-Control-*` 头。

**浏览器（`test/11-auth-browser.test.mjs`，Chrome）**：

```text
[A-after-pair] {"href":"http://127.0.0.1:<port>/","hash":"","cookie":"","events":["paired"]}
[A-ws] {"ok":true,"first":{"type":"banners",...},"close":null}
[B-events] ["bc-asked","bc-recv:credential/...","got-from-tab"]
[host-check] {"localhost":403,"rebind.test":403}
[logout] {"logoutStatus":200,"B":{"hasCredential":false,"wsClose":{"code":4403,"reason":"revoked:logout"},
          "events":[...,"bc-recv:logout/-","cleared:bc-logout"]}}
[restart] {"phaseC":"need-pair","eventsC":["bc-asked"],"aWhoami":401,"aPhase":"need-pair",
           "aEvents":[...,"bc-ignored","cleared:401-instance-changed"]}
```

- 配对后地址栏没有配对码；服务端日志里所有请求路径都不含配对码。
- 新标签页 B 从 A 经 `BroadcastChannel` 取得凭证后，`/api/whoami` 返回 200，WebSocket 首条消息是 `banners`。
- `rebind.test` 用 Chrome 的 `--host-resolver-rules` 映射到 127.0.0.1，模拟 DNS 重绑定。
- A 退出登录后，B 收到 `logout` 广播并清除凭证，B 的 WebSocket 被服务端以 4403 关闭，B 再请求得到 401。
- 同端口重启服务端后，新标签页 C 在频道里请求新 `instanceId` 的凭证，A 保存的是旧 `instanceId`，记录 `bc-ignored` 不回应，C 显示配对页；A 下次请求收到 401，响应里的 `instanceId` 与保存的不同，A 清除凭证回到配对页。

**同机其他端口的页面**（Chrome）：

| 尝试 | 页面观察到的结果 | pi-pane 服务端日志 |
| --- | --- | --- |
| `fetch(/api/instance)`（CORS） | `TypeError: Failed to fetch` | `GET /api/instance`，`Origin: http://127.0.0.1:<其他端口>` → 403 `bad_origin` |
| `fetch(/api/instance, { mode: "no-cors" })` | `opaque`，状态 0，读不到内容 | 请求不带 `Origin` → 200（该接口不需要鉴权，只返回 `instanceId`） |
| no-cors 的 `text/plain` POST 猜配对码 | `opaque`，状态 0 | 带 `Origin` → 403 `bad_origin`；该配对码的输错次数仍为 0 |
| 带 `Authorization` 的 `POST /api/ws-ticket` | `TypeError: Failed to fetch` | 只收到预检 `OPTIONS` → 403，没有 POST |
| `new WebSocket(ws://127.0.0.1:<port>/ws)` | 未打开，close 1006 | 握手 403 `bad_origin` |
| 同名 `BroadcastChannel` 索要凭证 | 1 秒观察窗口内没有收到任何消息 | pi-pane 标签页 A 的事件日志里没有这条消息；正向对照（同源标签页 B 在同一频道发请求）A 收到并回应 |
| `window.open` pi-pane 后读 `sessionStorage` | `SecurityError: ... Blocked a frame with origin "http://127.0.0.1:<其他端口>" from accessing a cross-origin frame.` | 弹出的 pi-pane 标签页正常加载（同源请求） |

服务端在攻击前后登记的凭证数相同，没有签发 ticket。跨端口请求的 `Sec-Fetch-Site` 在 Chrome 中为 `same-site`。

`BroadcastChannel` 一项是负向检查，只能用观察窗口：页面等 1 秒没有回应。为避免把“回应来得晚”误判成“消息没送达”，测试还用正向对照确认 A 的频道处理正常，并检查 A 的事件日志里没有其他端口发出的那条消息。

观察到的其他事实：

- **Cookie 不按端口隔离**：其他端口的页面设置 `p0_other_port=1` 后，pi-pane 页面的 `document.cookie` 变为 `p0_other_port=1`，之后 pi-pane 的请求都带 `Cookie: p0_other_port=1`。这与 architecture.md 不使用 Cookie 的理由一致。鉴权只看 `Authorization`，该 Cookie 不影响结果。
- **其他端口的页面可以打开 pi-pane 标签页**：`window.open` 打开的 pi-pane 标签页是同源页面，会按设计经 `BroadcastChannel` 从已登录的标签页取得凭证并进入已登录状态；打开它的页面读不到其中的内容。
- **不带 `Origin` 的 GET 能到达服务端**：no-cors GET 不带 `Origin`，只经过 `Host` 检查。需要鉴权的接口因为没有 `Authorization` 返回 401；不需要鉴权的 `/api/instance` 返回 200，但响应对其他源不透明。
- **本机有系统代理**：本机设有 `127.0.0.1:7890` 的系统代理。Chrome 在没有 `--no-proxy-server` 时把 `rebind.test` 的请求发给了这个代理，返回 `ERR_HTTP_RESPONSE_CODE_FAILURE`，请求没有到达原型服务端。驱动对 Chrome 加了 `--no-proxy-server`。这只影响实验，与设计无关。

### 对设计的理解

设计没有写到的细节，原型按以下理解实现：

- **“同一配对码连续输错 5 次后作废”**：服务端无法知道错误的码在猜哪一个，所以一次输错计入所有仍有效的配对码。`Origin` 不是规范源的请求先被拒绝，不计入输错次数。
- **401 响应**：所有 401 都在响应体里带当前 `instanceId`。标签页比较它与保存的 `instanceId`：不同时记为 `401-instance-changed`，相同时（凭证被吊销或过期）同样清除凭证。
- **什么算“活动”**：HTTP 请求、WebSocket 首帧鉴权、已鉴权连接上客户端发来的业务帧都算活动；服务端推送不算。连接保持打开但客户端一直不发帧时，凭证照样在 24 小时后过期，由 `sweep()` 吊销并关闭连接。`sweep()` 默认每 60 秒运行一次，所以这种情况下连接最多在过期后约 60 秒才关闭；设计没有规定这个间隔。
- **WebSocket 关闭码**：设计没有规定。原型对首帧无效（含 ticket 无效、过期、凭证已空闲过期）和 5 秒超时用 4401；对已鉴权连接的凭证被吊销（退出登录、空闲过期）用 4403，附原因 `revoked:<原因>`。业务帧触发的空闲过期也按吊销处理，同一凭证的所有连接都被关闭。首帧不是有效的 auth 时立即关闭，不等 5 秒。
- **ticket 一次性**：首帧里出现的 ticket 无论是否有效都立即作废。
- **配对码长度**：80 位随机数，20 个十六进制字符。
- **新标签页等待回应的时间**：`app.js` 在频道里索要凭证后最多等 1.5 秒，有回应立即结束，没有回应则显示配对页。设计没有规定这个时间。

### 结论

**macOS/Chrome 鉴权原型通过**。审查指出的两处原型缺陷（首帧被拒后连接不是终态；空闲过期只在 HTTP 上检查）返工时已修复，修复后的反例、空闲过期和其余全部场景在 macOS/Chrome 上通过，复审已确认修复；同机其他 `127.0.0.1` 端口的页面无法调用需要鉴权的接口，也拿不到凭证。仍需注意：不发帧的连接靠 `sweep()`（默认每 60 秒）吊销，最多在过期后约 60 秒才关闭；5 秒首帧超时的逻辑由可控时钟验证，真实墙钟时延只作记录，不是硬预算。本结论只针对原型，不代表生产实现已验收。Windows、Linux 待测。

## pane #12 设备密钥与签名

### 验证内容

按 [plugin-api.md](../../../docs/plugin-api.md#设备密钥) 的“设备密钥”和“签名格式”实现 `public/device-key.js`：

- `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])`，私钥 `extractable: false`，`CryptoKey` 直接存进 IndexedDB。
- 签名对象为 `{ "domain": "pi-pane/user-presence/v1", "payload": <payload> }` 的 RFC 8785 规范 JSON 的 UTF-8 字节；`signature` 为 WebCrypto 输出（IEEE P1363）的 base64url；`publicKey` 为 SPKI 的 base64url；`deviceId` 为 SPKI 字节 SHA-256 的 base64url。
- Node.js 端用 `crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)` 验签，规范 JSON 由 Node.js 独立计算。
- 刷新页面、重启浏览器（同一配置目录）后密钥仍在；其他源（其他端口）是另一台设备。
- 无痕：Chrome 用 off-the-record 的 BrowserContext，与无痕窗口使用同一机制，但不是从界面打开的无痕窗口。
- 不支持的环境：`http://insecure.test:<port>/`（Chrome 映射到 127.0.0.1，非 loopback 主机名的 http 页面不是安全上下文）。
- RFC 8785 的附录 B 数字向量、第 3.2.2 节示例和第 3.2.3 节排序示例在浏览器引擎中运行；签名用的 payload 含这些向量里的数字、需要按 UTF-16 码元排序的键和需要转义的字符串。

### 通过标准

四种浏览器都能签名并验签；不支持的环境给出 `unsupported`。

### 实测结果

Chrome（`evidence/12-device-key-browser.test.json`）：

```text
[support] {"ok":true}
[jcs-vector-failures] []
[device] {"deviceId":"OswApfcdvINfkTRTVvr33pW75lBbQfYbwVwcuMro_xA","publicKey":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...",
          "alg":"ECDSA-P256-SHA256","created":true}
[private-key] {"extractable":false,"type":"private","algorithm":{"name":"ECDSA","namedCurve":"P-256"},"usages":["sign"],
               "exports":{"pkcs8":"InvalidAccessError","jwk":"InvalidAccessError","raw":"InvalidAccessError"}}
[after-restart] {"created":false,"sameDevice":true}
[other-origin-device] {"created":true,"differs":true}
[insecure-context] {"support":{"ok":false,"reason":"insecure-context"},
                    "device":{"error":"unsupported","message":"insecure-context"}}
```

- 签名长度 64 字节（r‖s）；浏览器生成的规范 JSON 文本与 Node.js 独立计算的完全一致，包括 RFC 8785 向量数字和排序示例的键；Node.js 指定 `dsaEncoding: "ieee-p1363"` 验签通过。
- 同一个合法签名不指定 `dsaEncoding`（按 Node.js 默认的 DER）验证结果为 `false`。
- 页面刷新后从 IndexedDB 取回同一把密钥并能签名；关闭浏览器后用同一配置目录重启，密钥仍在。
- 其他端口的页面生成了另一把密钥，`deviceId` 不同。

无痕：

```text
chrome [private] {"support":{"ok":true},"device":{...,"created":true},"inspect":{"extractable":false,...},
                  "afterReload":{"created":false,"same":true},"verified":true}
chrome [private-reopen] {"created":true,"sameAsBefore":false}
```

Chrome 的无痕上下文里能生成密钥、存入 IndexedDB、在刷新后取回并签名，验签通过；关闭后重新打开是一台新设备。

### 对设计的理解

- **`unsupported` 的判定**：`isSecureContext` 为假、没有 `crypto.subtle`、没有 `indexedDB`，或生成密钥、写入或读回 IndexedDB 时出错（包括读回的不是 `CryptoKey`），都按 `unsupported` 处理。本组只在真实浏览器里触发了“非安全上下文”这一种；没有找到能在 Chrome 中关闭 IndexedDB 的方式，其他分支没有在浏览器中触发过。
- **签名时机**：原型在首次调用时生成密钥，没有接入“第一次登录时生成”的流程，这不影响本项要验证的浏览器能力。

### 结论

**通过（macOS/Chrome）**。macOS 上 Chrome 的普通窗口和无痕上下文都能签名并验签，非安全上下文给出 `unsupported`。浏览器范围按主人的决定只含 Chrome；Windows、Linux 待测。

## pane #14 前端打包体积

### 验证内容

`bundle/` 下的骨架：Preact 组件（消息列表、输入框）、markdown-it 渲染、highlight.js 高亮、highlight.js 的 `github.css` 主题。Markdown 按 [architecture.md](../../../docs/architecture.md#渲染与资源安全) 配置：`html: false`；链接只允许 `http:`、`https:`、`mailto:` 和 `#` 锚点；外部链接 `target="_blank" rel="noopener noreferrer"`；远程图片显示为链接“远程图片：<域名>”。

高亮的语言集合构建三个变体：

- `common`（主方案）：`highlight.js/lib/common`，约 35 种语言。
- `min`：核心加 12 种常见语言。
- `full`：全部语言，作为上限参考。

体积为构建输出目录（每次运行在系统临时目录下新建）中全部文件（HTML、JS、CSS）的 gzip 大小之和，用 Node.js `zlib.gzipSync` 的默认级别（6）计算，另记级别 9 和 brotli。构建产物用带设计 CSP 头（`lib/auth-server.mjs` 的 `cspFor`）的静态服务器提供，在 Chrome 中加载。

### 通过标准

Vite + Preact 骨架加上 Markdown 渲染、代码高亮和 CSP 后在 300 KiB（gzip）以内。

### 实测结果

| 变体 | 原始 | gzip（级别 6） | gzip（级别 9） | brotli |
| --- | --- | --- | --- | --- |
| common | 264.5 KiB | **97.9 KiB** | 97.8 KiB | 78.1 KiB |
| min | 176.0 KiB | 67.4 KiB | 67.3 KiB | 59.4 KiB |
| full | 1013.0 KiB | 342.9 KiB | 342.5 KiB | 275.0 KiB |

```text
[size-common] files: assets/index-*.css: raw 1.2 KiB, gzip 0.5 KiB；assets/index-*.js: raw 262.8 KiB, gzip 97.1 KiB；
              index.html: raw 0.4 KiB, gzip 0.3 KiB
[eval-scan] {"eval":0,"newFunction":0}
[csp-render] {"violations":[],"xss":false,"highlighted":true,"rawHtmlEscaped":true,"noJavascriptHref":true,
              "noDataHref":true,"remoteImageAsLink":true,"externalRel":true}
```

- Vite 生成的 `index.html` 只有带 `src` 的 `<script type="module">`，没有内联脚本；产物中没有 `eval(` 和 `new Function(`。
- Chrome 在 CSP 下加载，没有触发 `securitypolicyviolation`；代码块已高亮；`<img src=x onerror=...>` 按文本显示且没有执行；`javascript:` 和 `data:` 链接只剩文字；远程图片没有加载，显示为链接。
- highlight.js 全部语言的变体超过 300 KiB。

### 结论

**通过**。主方案 gzip 后 97.9 KiB，在 300 KiB 以内。体积与平台无关；CSP 下的运行在 macOS 的 Chrome 中检查过，Windows、Linux 待测。

## agora #16 设备签名验签

### 验证内容

按 pi-agora `docs/security.md` 的“用户确认”实现 `lib/confirm-verifier.mjs`：

- 挑战 `{ action, target, paramsHash, nonce, expiresAt }`，`paramsHash` 为请求参数规范 JSON 的 SHA-256（base64url）；挑战与完整请求参数一起存为待确认。
- `POST /v1/confirmations/:id/sign` 的请求体为 `{ deviceId, publicKey, alg, signature }`，按“验签”的 1–6 步依次检查，任何一步失败都拒绝并写审计；通过后同步完成“检查状态、消费 nonce、标为 confirmed、写审计”，相当于同一事务。
- 签名验证用记录的公钥和保存的挑战，不使用请求中的挑战内容。

场景（`test/presence-scenarios.mjs`）分别用两种签名方运行：Node.js WebCrypto（`test/16-verifier-node.test.mjs`）和 Chrome（`test/12-device-key-browser.test.mjs`）。

### 通过标准

合法签名通过；挑战重放、过期、参数被改、公钥不符全部被拒。

### 实测结果

两种签名方的结果相同。Chrome 签名时：

| 场景 | 结果 |
| --- | --- |
| 合法签名 | 200 |
| 重放：同一证明再次提交 | 第 1 步 409 `already_handled` |
| 重放：把证明用到另一条待确认 | 第 4 步 403 `bad_signature` |
| 过期（时钟前进到 `expiresAt` 之后） | 第 1 步 410 `expired` |
| 浏览器签名的挑战被改了 `target` / `paramsHash` / `action` / `expiresAt` | 都是第 4 步 403 `bad_signature` |
| 上述被拒之后提交合法签名 | 200 |
| 挑战生成后保存的请求参数被改 | 第 5 步 409 `challenge_mismatch` |
| 签名字节翻转 1 位 | 第 4 步 403 `bad_signature` |
| 其他 `domain`（`other-app/v1`）的签名 | 第 4 步 403 `bad_signature` |
| 重置设备密钥后，新密钥签名、声称旧 `deviceId`、附新公钥 | 第 3 步 403 `public_key_mismatch` |
| 新密钥签名、新 `deviceId`（未配对） | 第 3 步 403 `device_not_paired` |
| 旧 `deviceId` 和旧公钥、新密钥的签名 | 第 4 步 403 `bad_signature` |
| `alg` 为 `ES256` | 第 3 步 400 `bad_alg` |
| 并发提交同一合法签名两次 | 一次 200，另一次在提交时 409 `already_handled` |
| 待确认的 nonce 已被使用 | 第 2 步 409 `nonce_used` |
| 目标状态已不允许 | 第 6 步 409 `invalid_state` |
| 含 RFC 8785 向量的 payload | 浏览器与 Node.js 的规范 JSON 文本相同，验签通过 |

```text
[presence-scenarios] {"legit":{"ok":true,"status":200},"replay-same":{"ok":false,"status":409,"code":"already_handled","step":1},
  "replay-other-confirmation":{...,"code":"bad_signature","step":4},"expired":{"ok":false,"status":410,"code":"expired","step":1},
  ...,"verify-p1363":true,"verify-der-default":false,...,
  "concurrent":[{"ok":true,"status":200},{"ok":false,"status":409,"code":"already_handled","step":"commit"}],...}
```

全程只执行了 3 次原操作：合法签名、被改挑战被拒后的合法签名、并发中成功的一次。

### 对设计的理解

- **签名请求不带挑战内容**：security.md 的 sign 请求体只有 `{ deviceId, publicKey, alg, signature }`，daemon 用自己保存的挑战验签。因此“参数被改”在浏览器签了被改的挑战时表现为第 4 步签名无效；第 5 步只在保存的请求与挑战不一致时触发，原型用直接修改保存的参数来模拟。
- **nonce 何时作废**：security.md 写“使用后立即作废”，没有说明验签失败的提交是否也作废。原型只在验签全部通过、执行时消费 nonce，被拒的提交不作废待确认（否则任何人提交一个错误签名就能让用户的确认失效）。
- **并发**：两次提交在异步检查中交错，提交前再检查一次状态，后到的一次返回 `already_handled`。
- **错误码和 HTTP 状态**：除 `409 already_handled` 外 security.md 没有规定，表中的其他码是原型自定。
- **`alg` 检查**：security.md 的 1–6 步没有列出，原型放在第 3 步。

### 结论

**通过**。验签逻辑与平台无关，Node.js 和 macOS Chrome 生成的签名在全部场景中按预期通过或被拒。其他浏览器生成的签名随 pane #12 补测；Windows、Linux 待测。

## 进程与临时文件

- 浏览器由 playwright-core 启动并在每个子测试结束时关闭。测试结束后检查进程表，没有本组遗留的浏览器或 Node.js 进程。
- 浏览器配置目录在系统临时目录下（`p0-f-*`），测试结束时删除。
- #14 的构建输出在系统临时目录下（`p0-f-bundle-*`），测试结束时删除。
- `node_modules/`、`.browsers/`、`.evidence/`、`bundle/dist-*/`、`.tmp/` 已列入 `.gitignore`。
