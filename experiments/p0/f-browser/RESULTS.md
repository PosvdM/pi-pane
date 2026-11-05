# P0 F 组：浏览器与鉴权

本组验证 pi-pane roadmap 的 #11、#12、#14 和 pi-agora roadmap 的 #16。实验不涉及 pi 进程，没有使用 `experiments/p0/harness/`。

## 结论

| 项 | 结论 | 说明 |
| --- | --- | --- |
| pane #11 鉴权 | 部分通过 | 服务端原型按设计工作；Chrome 中全部场景通过，同机其他 `127.0.0.1` 端口的页面无法调用接口。Safari 需主人手动开启远程自动化，Firefox、Edge 未测；Windows、Linux 待测 |
| pane #12 设备密钥与签名 | 部分通过 | Chrome 普通窗口和无痕上下文都能生成不可导出的密钥、存入 IndexedDB、签名并在 Node.js 中验签；非安全上下文返回 `unsupported`。Safari 需主人手动，Firefox、Edge 未测；Windows、Linux 待测 |
| pane #14 前端打包体积 | 通过 | Vite + Preact + markdown-it + highlight.js（common 语言集）gzip 后 97.9 KiB；构建产物在设计的 CSP 下运行，没有违规 |
| agora #16 设备签名验签 | 通过 | 验签原型按 security.md 的 1–6 步实现；Chrome 生成的合法签名通过，其余 17 次提交（重放、过期、参数被改、公钥不符等）全部被拒。Windows、Linux 待测 |

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS 27.0.1（26A434），Apple Silicon |
| Node.js | v26.12.0 |
| 浏览器驱动 | playwright-core 1.64.1，浏览器以 headless 模式运行；Safari 用系统自带的 `safaridriver` |
| 前端依赖 | vite 8.3.5、preact 11.1.1、@preact/preset-vite 2.10.6、markdown-it 15.0.3、highlight.js 11.12.0 |

本机浏览器的情况：

| 浏览器 | 情况 | 本组的处理 |
| --- | --- | --- |
| Chrome | 已安装 156.0.8078.80 | 用 playwright-core 的 `channel: "chrome"` 驱动本机 Chrome，headless，临时配置目录 |
| Safari | 已安装 27.0.1，未开启“允许远程自动化” | **需主人手动**。`safaridriver` 创建会话时返回 `Could not create a session: You must enable 'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver.`。驱动代码已写好（`lib/browsers.mjs` 的 `launchSafari`），但没有实际跑过 |
| Edge | 未安装 | **未测**。`/Applications/Microsoft Edge.app` 不存在；Playwright 安装 Edge 需要全局安装，不在本组权限内 |
| Firefox | 未安装 | **未测**。下载了 Playwright 自带的 Firefox 157.0（`.browsers/firefox-1555`），但它在本机无法启动：`launch`、`launchPersistentContext` 和直接运行可执行文件都输出 `Could not find profile folder.` 后以退出码 1 结束；换配置目录位置、设 `XRE_PROFILE_PATH` 都一样，原因未查明。主人的 `~/Library/Application Support` 下没有因此新建任何目录 |
| WebKit（Playwright 构建） | 已下载 WebKit 27.2 | 只作参考，不等于 Safari：它不是 Apple 发行的 Safari，结果不能替代 Safari 的结论 |

## 重跑

在 `experiments/p0/f-browser/` 下执行：

```sh
npm install          # 安装到本目录的 node_modules
npm run browsers     # 下载 Playwright 的 Firefox、WebKit 到本目录的 .browsers/
npm test             # node --test test/*.test.mjs
```

- 只跑部分浏览器：`P0_BROWSERS=chrome,safari npm test`。主人开启 Safari 的远程自动化后，用这条命令补测 Safari。
- 不装依赖也能跑的部分：`node --test test/11-auth-server.test.mjs test/16-verifier-node.test.mjs`（零依赖，只用 Node.js 内置模块）。
- 不可用的浏览器按子测试 skip，原因写在 skip 信息里。
- 手动试用鉴权原型：`node lib/auth-server.mjs 4319`，终端打印带配对码的地址，按 Enter 生成新配对码。

最近一次 `npm test` 的输出摘要：

```text
ℹ tests 33
ℹ pass 24
ℹ fail 0
ℹ skipped 9
```

9 个 skip 是 3 组浏览器测试中的 Edge（未安装）、Firefox（无法启动）、Safari（需主人手动）。

## 文件

| 路径 | 内容 |
| --- | --- |
| `lib/auth-server.mjs` | pane #11 鉴权原型服务端：Host/Origin 检查、配对码、Bearer 凭证、ws-ticket、WebSocket 首帧鉴权、安全响应头 |
| `lib/ws.mjs` | 零依赖的最小 WebSocket 实现（服务端握手、文本帧、close） |
| `lib/plain-server.mjs` | 不做任何检查的静态服务器，模拟“同机其他 `127.0.0.1` 端口”，也用于非安全上下文 |
| `lib/confirm-verifier.mjs` | agora #16 验签原型：待确认、挑战、按 security.md 的 1–6 步验签 |
| `lib/browsers.mjs` | 浏览器驱动：Playwright（Chrome、Edge、Firefox、WebKit）和 safaridriver（Safari） |
| `public/` | 浏览器端原型：`app.js`（配对、`sessionStorage`、`BroadcastChannel`、WebSocket）、`device-key.js`（设备密钥与签名）、`jcs.js`（RFC 8785，浏览器与 Node.js 共用）、`jcs-vectors.js`（RFC 8785 测试数据） |
| `evil/` | 其他端口上的攻击页面 |
| `bundle/` | pane #14 的 Vite + Preact 骨架 |
| `scripts/install-browsers.mjs` | `npm run browsers` 的实现：把 Playwright 的浏览器下载到本目录 |
| `test/` | `node --test` 测试 |

## pane #11 鉴权

### 验证内容

按 [architecture.md](../../../docs/architecture.md#鉴权) 写一个最小原型（`lib/auth-server.mjs`、`public/app.js`），覆盖：

- 配对码换会话凭证：地址 `/#code=<配对码>`，兑换后用 `history.replaceState` 移除；配对码一次性、10 分钟过期、连续输错 5 次作废；也可手动输入。
- 只服务规范源：`Host` 必须正好是 `127.0.0.1:<port>`，`localhost` 和其他域名都拒绝；带 `Origin` 时必须是规范源；不开放 CORS。
- 会话凭证只在内存和 `sessionStorage`，用 `Authorization: Bearer` 发送；24 小时无活动失效；退出登录立即吊销；服务端重启后全部失效。
- 新标签页经同源 `BroadcastChannel` 按 `instanceId` 取得凭证；退出登录时广播 `logout`；服务端重启后旧标签页不交出失效凭证。
- WebSocket：先 `POST /api/ws-ticket` 取 30 秒一次性 ticket，首帧 `{ "type": "auth", "ticket": "…" }`，5 秒内没有有效首帧即关闭；首帧前不推送；鉴权后先发 `banners`；吊销凭证时关闭连接。
- 所有响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和 CSP；没有 `Set-Cookie`。
- 同机其他 `127.0.0.1` 端口的页面尝试调用接口：CORS 读取、no-cors 读取、简单请求 POST 猜配对码、带 `Authorization` 的预检请求、WebSocket、同名 `BroadcastChannel`、`window.open` 后读 `sessionStorage`。

### 通过标准

全部按设计；同机其他 `127.0.0.1` 端口的页面无法调用 pi-pane 接口。

### 实测结果

**服务端（`test/11-auth-server.test.mjs`，Node.js 直接发请求，可以伪造浏览器发不出的头）**：9 个测试全部通过。

```text
[host-matrix] 127.0.0.1:<port> → 200；localhost:<port>、LOCALHOST:<port>、localhost.:<port>、127.0.0.1（无端口）、
              127.0.0.1:<port+1>、evil.test:<port>、[::1]:<port>、127.1:<port>、2130706433:<port>、空 Host → 403
[origin-matrix] {"http://127.0.0.1:54363":200,"http://127.0.0.1:54364":403,"http://localhost:54363":403,
                 "https://127.0.0.1:54363":403,"null":403,"http://127.0.0.1:54363/":403,"OPTIONS cross-origin":403}
[code-format] 20 hex chars = 80 bits
[ws-handshake] {"canonical":101,"no-origin":101,"other-port-origin":403,"localhost-host":403,
                "localhost-host-canonical-origin":403,"null-origin":403}
[ws-close-codes] 重用 ticket → 4401 unknown_ticket；首帧不是 auth → 4401 bad_first_frame；
                 过期 ticket → 4401 expired_ticket；退出登录 → 4403 revoked:logout
[ws-timeout] {"code":4401,"reason":"auth timeout","ms":5001}
[restart] {"old":"Vq7Sbd1EJkjPKe76","new":"vakrZQiegNFd5vLE","status":401,
           "body":{"error":"unauthorized","instanceId":"vakrZQiegNFd5vLE"}}
```

其他检查：配对码重用、过期（时钟前进 10 分钟 + 1 毫秒）、输错 5 次后作废，输错 4 次后仍可用；`Cookie` 头和 URL 参数里的凭证都不被接受；ticket 放在 URL 里不起作用，仍要首帧；首帧前等待 300 毫秒没有收到任何数据；鉴权后第一条消息是 `banners`；所有响应都没有 `Set-Cookie` 和 `Access-Control-*` 头。

**浏览器（`test/11-auth-browser.test.mjs`）**：Chrome 和 WebKit 通过。以下摘自 Chrome：

```text
[A-after-pair] {"href":"http://127.0.0.1:56086/","hash":"","cookie":"","events":["paired"]}
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
- `rebind.test` 用 Chrome 的 `--host-resolver-rules` 映射到 127.0.0.1，模拟 DNS 重绑定。WebKit 无法映射主机名，只测了 `localhost`。
- A 退出登录后，B 收到 `logout` 广播并清除凭证，B 的 WebSocket 被服务端以 4403 关闭，B 再请求得到 401。
- 同端口重启服务端后，新标签页 C 在频道里请求新 `instanceId` 的凭证，A 保存的是旧 `instanceId`，记录 `bc-ignored` 不回应，C 显示配对页；A 下次请求收到 401，响应里的 `instanceId` 与保存的不同，A 清除凭证回到配对页。

**同机其他端口的页面**（Chrome；WebKit 结果相同，错误文字为 `TypeError: Load failed`）：

| 尝试 | 页面观察到的结果 | pi-pane 服务端日志 |
| --- | --- | --- |
| `fetch(/api/instance)`（CORS） | `TypeError: Failed to fetch` | `GET /api/instance`，`Origin: http://127.0.0.1:<其他端口>` → 403 `bad_origin` |
| `fetch(/api/instance, { mode: "no-cors" })` | `opaque`，状态 0，读不到内容 | 请求不带 `Origin` → 200（该接口不需要鉴权，只返回 `instanceId`） |
| no-cors 的 `text/plain` POST 猜配对码 | `opaque`，状态 0 | 带 `Origin` → 403 `bad_origin`；该配对码的输错次数仍为 0 |
| 带 `Authorization` 的 `POST /api/ws-ticket` | `TypeError: Failed to fetch` | 只收到预检 `OPTIONS` → 403，没有 POST |
| `new WebSocket(ws://127.0.0.1:<port>/ws)` | 未打开，close 1006 | 握手 403 `bad_origin` |
| 同名 `BroadcastChannel` 索要凭证 | 1 秒内没有收到任何消息 | pi-pane 标签页也没有收到这条消息 |
| `window.open` pi-pane 后读 `sessionStorage` | `SecurityError: ... Blocked a frame with origin "http://127.0.0.1:<其他端口>" from accessing a cross-origin frame.` | 弹出的 pi-pane 标签页正常加载（同源请求） |

服务端在攻击前后登记的凭证数相同，没有签发 ticket。跨端口请求的 `Sec-Fetch-Site` 在 Chrome 中为 `same-site`。

观察到的其他事实：

- **Cookie 不按端口隔离**：其他端口的页面设置 `p0_other_port=1` 后，pi-pane 页面的 `document.cookie` 变为 `p0_other_port=1`，之后 pi-pane 的请求都带 `Cookie: p0_other_port=1`（Chrome 和 WebKit 相同）。这与 architecture.md 不使用 Cookie 的理由一致。鉴权只看 `Authorization`，该 Cookie 不影响结果。
- **其他端口的页面可以打开 pi-pane 标签页**：`window.open` 打开的 pi-pane 标签页是同源页面，会按设计经 `BroadcastChannel` 从已登录的标签页取得凭证并进入已登录状态；打开它的页面读不到其中的内容。
- **不带 `Origin` 的 GET 能到达服务端**：no-cors GET 不带 `Origin`，只经过 `Host` 检查。需要鉴权的接口因为没有 `Authorization` 返回 401；不需要鉴权的 `/api/instance` 返回 200，但响应对其他源不透明。
- **本机有系统代理**：本机设有 `127.0.0.1:7890` 的系统代理。Chrome 在没有 `--no-proxy-server` 时把 `rebind.test` 的请求发给了这个代理，返回 `ERR_HTTP_RESPONSE_CODE_FAILURE`，请求没有到达原型服务端。驱动已改为对 Chrome 加 `--no-proxy-server`、对 Firefox 设 `network.proxy.type = 0`。这只影响实验，与设计无关。

### 对设计的理解

设计没有写到的细节，原型按以下理解实现：

- **“同一配对码连续输错 5 次后作废”**：服务端无法知道错误的码在猜哪一个，所以一次输错计入所有仍有效的配对码。`Origin` 不是规范源的请求先被拒绝，不计入输错次数。
- **401 响应**：所有 401 都在响应体里带当前 `instanceId`。标签页比较它与保存的 `instanceId`：不同时记为 `401-instance-changed`，相同时（凭证被吊销或过期）同样清除凭证。
- **WebSocket 关闭码**：设计没有规定。原型对 ticket 无效、首帧不是 auth、5 秒超时用 4401，对吊销用 4403。首帧不是有效的 auth 时立即关闭，不等 5 秒。
- **ticket 一次性**：首帧里出现的 ticket 无论是否过期都立即作废。
- **配对码长度**：80 位随机数，20 个十六进制字符。

### 结论

**部分通过**。macOS 上 Chrome 的全部场景通过，同机其他 `127.0.0.1` 端口的页面无法调用需要鉴权的接口，也拿不到凭证。Safari 需主人开启“允许远程自动化”后补测；Firefox、Edge 未测；Windows、Linux 待测。

## pane #12 设备密钥与签名

### 验证内容

按 [plugin-api.md](../../../docs/plugin-api.md#设备密钥) 的“设备密钥”和“签名格式”实现 `public/device-key.js`：

- `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])`，私钥 `extractable: false`，`CryptoKey` 直接存进 IndexedDB。
- 签名对象为 `{ "domain": "pi-pane/user-presence/v1", "payload": <payload> }` 的 RFC 8785 规范 JSON 的 UTF-8 字节；`signature` 为 WebCrypto 输出（IEEE P1363）的 base64url；`publicKey` 为 SPKI 的 base64url；`deviceId` 为 SPKI 字节 SHA-256 的 base64url。
- Node.js 端用 `crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)` 验签，规范 JSON 由 Node.js 独立计算。
- 刷新页面、重启浏览器（同一配置目录）后密钥仍在；其他源（其他端口）是另一台设备。
- 无痕：Chrome 用 off-the-record 的 BrowserContext，与无痕窗口使用同一机制，但不是从界面打开的无痕窗口；WebKit 用临时 context，只作参考。
- 不支持的环境：`http://insecure.test:<port>/`（Chrome 映射到 127.0.0.1，非 loopback 主机名的 http 页面不是安全上下文）。
- RFC 8785 的附录 B 数字向量、第 3.2.2 节示例和第 3.2.3 节排序示例在浏览器引擎中运行；签名用的 payload 含这些向量里的数字、需要按 UTF-16 码元排序的键和需要转义的字符串。

### 通过标准

四种浏览器都能签名并验签；不支持的环境给出 `unsupported`。

### 实测结果

Chrome（WebKit 参考结果相同）：

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

Chrome 的无痕上下文里能生成密钥、存入 IndexedDB、在刷新后取回并签名，验签通过；关闭后重新打开是一台新设备。WebKit 临时 context 的结果相同。

### 对设计的理解

- **`unsupported` 的判定**：`isSecureContext` 为假、没有 `crypto.subtle`、没有 `indexedDB`，或生成密钥、写入或读回 IndexedDB 时出错（包括读回的不是 `CryptoKey`），都按 `unsupported` 处理。本组只在真实浏览器里触发了“非安全上下文”这一种；没有找到能在 Chrome 中关闭 IndexedDB 的方式，其他分支没有在浏览器中触发过。
- **签名时机**：原型在首次调用时生成密钥，没有接入“第一次登录时生成”的流程，这不影响本项要验证的浏览器能力。

### 结论

**部分通过**。macOS 上 Chrome 的普通窗口和无痕上下文都能签名并验签，非安全上下文给出 `unsupported`。Safari（含无痕窗口，`safaridriver` 没有无痕会话选项）需主人手动；Firefox、Edge 未测；Windows、Linux 待测。

## pane #14 前端打包体积

### 验证内容

`bundle/` 下的骨架：Preact 组件（消息列表、输入框）、markdown-it 渲染、highlight.js 高亮、highlight.js 的 `github.css` 主题。Markdown 按 [architecture.md](../../../docs/architecture.md#渲染与资源安全) 配置：`html: false`；链接只允许 `http:`、`https:`、`mailto:` 和 `#` 锚点；外部链接 `target="_blank" rel="noopener noreferrer"`；远程图片显示为链接“远程图片：<域名>”。

高亮的语言集合构建三个变体：

- `common`（主方案）：`highlight.js/lib/common`，约 35 种语言。
- `min`：核心加 12 种常见语言。
- `full`：全部语言，作为上限参考。

体积为 `dist-<变体>/` 下全部文件（HTML、JS、CSS）的 gzip 大小之和，用 Node.js `zlib.gzipSync` 的默认级别（6）计算，另记级别 9 和 brotli。构建产物用带设计 CSP 头（`lib/auth-server.mjs` 的 `cspFor`）的静态服务器提供，在 Chrome 和 WebKit 中加载。

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
- Chrome 和 WebKit 在 CSP 下加载，没有触发 `securitypolicyviolation`；代码块已高亮；`<img src=x onerror=...>` 按文本显示且没有执行；`javascript:` 和 `data:` 链接只剩文字；远程图片没有加载，显示为链接。
- highlight.js 全部语言的变体超过 300 KiB。

### 结论

**通过**。主方案 gzip 后 97.9 KiB，在 300 KiB 以内。体积与平台无关；CSP 下的运行在 macOS 的 Chrome 和 WebKit 中检查过，Windows、Linux 待测。

## agora #16 设备签名验签

### 验证内容

按 pi-agora `docs/security.md` 的“用户确认”实现 `lib/confirm-verifier.mjs`：

- 挑战 `{ action, target, paramsHash, nonce, expiresAt }`，`paramsHash` 为请求参数规范 JSON 的 SHA-256（base64url）；挑战与完整请求参数一起存为待确认。
- `POST /v1/confirmations/:id/sign` 的请求体为 `{ deviceId, publicKey, alg, signature }`，按“验签”的 1–6 步依次检查，任何一步失败都拒绝并写审计；通过后同步完成“检查状态、消费 nonce、标为 confirmed、写审计”，相当于同一事务。
- 签名验证用记录的公钥和保存的挑战，不使用请求中的挑战内容。

场景（`test/presence-scenarios.mjs`）分别用三种签名方运行：Node.js WebCrypto（`test/16-verifier-node.test.mjs`）、Chrome、WebKit（`test/12-device-key-browser.test.mjs`）。

### 通过标准

合法签名通过；挑战重放、过期、参数被改、公钥不符全部被拒。

### 实测结果

三种签名方的结果相同。Chrome 签名时：

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

- 浏览器由 playwright-core 启动并在每个子测试结束时关闭；`safaridriver` 由驱动按 PID 所在进程组终止。测试结束后检查进程表，没有本组遗留的浏览器、`safaridriver` 或 Node.js 进程。
- 浏览器配置目录在系统临时目录下（`p0-f-*`），测试结束时删除。
- `node_modules/`、`.browsers/`、`bundle/dist-*/`、`.tmp/` 已列入 `.gitignore`。
