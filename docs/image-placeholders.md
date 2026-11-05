# 图片占位符

> 状态：设计草案。送给 pi 的编码方式依赖 P0 验证，验证通过后冻结。

用户可以把图片插在文字中的任意位置，例如：

```text
看看这张图[Image #1]，再对比[Image #2]
```

模型收到的消息里，图片按这个顺序和文字交错排列，而不是全部堆在文字后面。

## 输入框

### 内容模型

输入框的内容是“文本 + 原子图片节点”的序列：

```ts
// 草案
type DraftNode =
  | { type: "text"; text: string }
  | { type: "image"; assetId: string };
```

上例在输入框内部是：

```json
[
  { "type": "text", "text": "看看这张图" },
  { "type": "image", "assetId": "sha256-9f2c…" },
  { "type": "text", "text": "，再对比" },
  { "type": "image", "assetId": "sha256-41ab…" }
]
```

### 编号

- `[Image #n]` 只是显示标签，内部始终用 `assetId` 引用图片。
- 编号按图片在输入框中出现的位置实时计算，从 1 开始连续。移动、删除图片后编号随之更新，所以用户在文字里写的“#2”总是指当前第二张图。
- 发送时的编号与发送那一刻的显示一致，并写进发给模型的文字里（见“送给 pi”）。

### 操作

| 操作 | 行为 |
| --- | --- |
| 粘贴图片、拖入图片、点“添加图片” | 上传到服务端得到 `assetId`，在光标处插入图片节点 |
| 退格、删除 | 图片节点作为一个整体删除 |
| 在输入框内拖动图片节点 | 移动位置，编号更新 |
| 撤销、重做 | 恢复或再次删除图片节点（`assetId` 不变） |
| 在输入框内剪切、复制、粘贴 | 内部剪贴板保留图片节点 |
| 复制到其他程序 | 得到纯文本 `[Image #n]` |
| 悬停在节点上 | 显示缩略图 |

**手动输入的 `[Image #1]` 是普通文字**，不会关联任何图片。只有通过上述操作插入的节点才是图片。

### 发送前校验

- 每个 `assetId` 都已上传成功且在服务端存在；
- 类型是 PNG、JPEG、GIF 或 WebP；
- 单张不超过 4 MiB、单条消息不超过 10 张且合计不超过 12 MiB（均指浏览器缩放后的大小，见“上传”；**上限待定**，P0 按各模型服务的限制调整）。pi 把一条用户消息连同 base64 图片写成会话文件的一行，base64 还会把体积放大约三分之一，上限定得低是为了避免出现几十 MiB 的单行 JSONL；
- 以上检查浏览器先做一次，服务端在发给 pi 之前再做一次，不通过的不发送；
- 当前模型支持图片输入：RPC `get_state` 返回的模型对象中 `input` 包含 `"image"`（依据：pi `docs/rpc-commands.md` 的 Model object）。不支持时禁止发送并提示切换模型。

### 草稿保存

- 每个会话的草稿（节点序列，只含 `assetId`，不含图片数据）保存在浏览器 `localStorage`，刷新页面后恢复。
- 服务端看不到浏览器里的草稿，不按“是否被草稿引用”决定清理，而是按期限清理（见“清理”）。
- 恢复草稿时，前端用 `POST /api/assets/touch` 提交草稿里的全部 `assetId`：仍存在的延长期限，已删除的在响应中列出。已删除的图片节点显示“图片已过期，请重新添加”，在用户删掉或替换之前不能发送。

## assetId 与存储

- `assetId = "sha256-" + 上传的图片字节（浏览器缩放后）的 sha256 十六进制`，内容相同的图片只存一份。
- 存储位置：

  ```text
  ~/.pi/pane/assets/<hex 前两位>/<hex>.<扩展名>     图片（发给 pi 的就是这份）
  ~/.pi/pane/assets/<hex 前两位>/<hex>.thumb.webp   缩略图（最长边 256 像素）
  ~/.pi/pane/assets/<hex 前两位>/<hex>.json         元数据：mimeType、size、width、height、createdAt
  ```

- 服务端不依赖图像处理的原生模块，缩放和缩略图都在浏览器里用 canvas 完成。
- 图片发送后，pi 会把图片数据（base64）写进会话文件，历史消息的显示以会话文件为准，不依赖 assets 目录。

### 上传

1. 浏览器读取图片。最长边超过 2000 像素或大小超过单张上限时，用 canvas 缩放到最长边 2000 像素并重新编码（2000 与 pi `images.autoResize` 的默认尺寸一致，依据：pi `docs/settings.md`）。PNG、JPEG、WebP 保持原类型；GIF 需要缩放时只保留第一帧，转为 PNG 并提示用户。缩放后仍超过单张上限时拒绝添加。
2. 浏览器生成最长边 256 像素的 WebP 缩略图。
3. `POST /api/assets`，`Content-Type: multipart/form-data`，两个部分：`image`（第 1 步得到的字节，带图片类型）和 `thumb`（缩略图）。服务端检查文件头与声明的类型一致、大小不超限，计算 `assetId`，响应 `{ assetId, width, height }`。

### 清理

- 每个资源记录最后使用时间：上传、发送、`touch` 都会更新。
- 最后使用超过 7 天的资源由服务端定期删除（**期限待定**）。已发送的图片在会话文件里，删除 assets 不影响历史消息。
- 草稿里引用的资源被删除后，按“草稿保存”中的方式提示。

### 历史消息中的图片

会话文件和插件提供的条目里，图片是内联的 base64。服务端发给浏览器的快照、历史页和 `pane_entries` 事件里不内联图片：

- 服务端把每个 `ImageContent` 解码、计算 sha256，存入 `~/.pi/pane/cache/blobs/`，在发给浏览器的数据里把它替换为 `{ "type": "image", "mimeType": "…", "blob": "sha256-<hex>", "width": …, "height": … }`。
- 浏览器用 `fetch` 带 `Authorization` 头请求 `GET /api/blobs/sha256-<hex>`，转成 `blob:` URL 显示，并按哈希缓存。
- `cache/blobs/` 是从会话文件派生的缓存，按总大小（默认 1 GiB）淘汰最久未用的文件，可以随时删除；缺失时服务端从会话文件重新提取。
- 只有 PNG、JPEG、GIF、WebP 按图片显示，其他类型只显示类型和大小（见 [architecture.md](architecture.md#渲染与资源安全)）。

## 送给 pi

### 问题

pi 的消息类型允许用户消息的内容是有序的 `(TextContent | ImageContent)[]`（依据：pi `docs/message-types.md`），但现有提交路径会拆散顺序：

- RPC `prompt`、`steer`、`follow_up` 命令只有 `message`（字符串）和 `images`（数组）两个字段（依据：pi `docs/rpc-commands.md`）。
- 扩展的 `sendUserMessage()` 把内容数组里的文字合并成一个字符串、图片另放一个数组，再调用 `prompt()`（依据：`dist/core/agent-session.js` 第 1924 行起）。

两条路径最终都得到“所有文字在前、所有图片在后”的用户消息。

### 做法：发送时编码，`message_end` 时还原

1. **pi-pane 服务端编码**：把草稿转成一个带标记的字符串和按顺序排列的图片数组，用 RPC `prompt`（或 `steer`、`follow_up`）发出。

   ```text
   message: "看看这张图⟦pane-img:k3f9x2:1⟧，再对比⟦pane-img:k3f9x2:2⟧"
   images:  [ <图片 1>, <图片 2> ]
   ```

   标记格式 `⟦pane-img:<nonce>:<k>⟧`：`nonce` 是每条消息随机生成的 6–8 位小写字母数字，`k` 从 1 开始连续，与 `images` 的下标一一对应。

2. **pane-bridge 扩展还原**：pane-bridge 在主会话进程里注册 `message_end` 处理器。看到角色为 `user`、文字里含有标记的消息时：
   - 校验：所有标记的 `nonce` 相同，`k` 从 1 连续到 N，N 等于消息中图片的数量；
   - 按标记切分文字，每段文字末尾补上显示标签 `[Image #k]`，后面紧跟第 k 张图片，最后一段文字放在末尾；
   - 返回替换后的消息（角色不变、时间戳不变）。

   ```json
   [
     { "type": "text", "text": "看看这张图[Image #1]" },
     { "type": "image", "data": "…", "mimeType": "image/png" },
     { "type": "text", "text": "，再对比[Image #2]" },
     { "type": "image", "data": "…", "mimeType": "image/png" }
   ]
   ```

   依据：`dist/core/extensions/types.d.ts` 的 `MessageEndEventResult`（“Replace the finalized message. The replacement must keep the original message role.”）；`dist/core/agent-session.js` 中 `message_end` 先交给扩展处理并原地替换消息（`_replaceMessageInPlace`，第 944–960 行），之后才写入会话文件（第 760–779 行）。

3. **校验不通过**：不替换，扩展用 `ctx.ui.notify` 发警告，pi-pane 在该消息上标注“图片顺序未还原”。

保留 `[Image #k]` 标签文字，是为了让模型和用户能用同一个编号指代图片。

带标记的文字还有一个用处：pi 在用户消息开始时按完全相同的文字把它从 steer/follow-up 队列里删除（`message_start` 早于 `message_end` 的替换，依据：`dist/core/agent-session.js` 第 738–757 行），每条消息的 `nonce` 不同，所以 pi-pane 能把 `queue_update` 和 `clear_queue` 返回的文字唯一对应到自己发出的草稿（见 [architecture.md](architecture.md#steer-与-follow-up-的送达)）。

### 没有 pane-bridge 时

pane-bridge 没有就绪（加载失败、回连失败、会话替换后没有重新绑定）时，服务端不向该会话发送任何输入，并在就绪超时后终止该进程：会话写锁也依赖 pane-bridge，此时继续运行不安全，见 [architecture.md](architecture.md#会话替换后的重绑定)。用户只能只读查看或重启该会话，不存在“没有 pane-bridge 但照常发送”的运行状态。

### 备用编码

“文字中带 `[Image #k]` 标签 + 图片按编号排在末尾”（不发送标记，也不需要 pane-bridge 还原）是设计层面的备用方案：只在 P0 证明 `message_end` 替换不可用时，整体改用这种编码，并在输入框上方提示“图片将附在文字之后”。它不是单个会话在缺少 pane-bridge 时的运行时退路。

### 未采用的方案

- **用 `pi.sendMessage` 发自定义消息**：自定义消息的内容也支持图文交错（依据：pi `docs/message-types.md` 的 CustomMessage），但角色是 `custom`，不是用户消息，steer/follow-up 的语义、会话导出和其他客户端的显示都会不同。
- **直接修改 agent 状态或手工改写会话文件**：绕过 pi 的公开接口，pi 升级后容易失效。

长期方案是让 pi 的 RPC 命令和 `sendUserMessage()` 直接接受有序内容。向 pi 上游提 issue 或 PR 属于对外操作，需另行批准。

## 显示

- 用户消息按 `content` 的顺序渲染：文字段落中间插入缩略图，点击查看原图。
- 文字中的 `[Image #k]` 标签渲染为带编号的小标签，悬停显示对应图片。
- 未经还原的旧消息（文字在前、图片在后）按原顺序显示，不做猜测。

## P0 验证清单

验证方法：准备 3 张容易区分的图片（如红色方块、蓝色圆形、写着字母 C 的白底图），按“第一张[Image #1]……第二张[Image #2]……第三张[Image #3]”的格式发送，要求模型按编号描述每张图。每个场景重复 3 次，全部正确才算通过。

| # | 场景 | 检查点 |
| --- | --- | --- |
| 1 | 普通发送（`prompt`） | 模型描述正确；会话文件中 `content` 为交错顺序 |
| 2 | 运行中 steer | steer 送达后的用户消息同样被还原；pi 的 steer 队列正常出队（`queue_update` 事件） |
| 3 | follow-up | 同上 |
| 4 | 恢复 | 关闭会话、重新拉起进程后继续对话，模型仍能按编号指代之前的图片 |
| 5 | 导出 | RPC `export_html` 的结果按交错顺序显示 |
| 6 | 压缩 | 手动 `compact` 和自动压缩都不报错；压缩后的对话可以继续 |
| 7 | 四个模型 | Claude、GPT（Sol）、GPT（Astra）、Gemini 分别通过场景 1 |
| 8 | 时序 | 确认 `message_end` 的扩展处理在本轮模型请求之前完成（模型收到的是替换后的消息） |
| 9 | 自动缩放 | `images.autoResize` 开启（默认，依据：pi `docs/settings.md`）时顺序和对应关系不变 |
| 10 | 边界 | 只有图片没有文字；两张图片紧挨；10 张图片；标记被用户手动输入的相似文字干扰 |
| 11 | 备用编码 | 按“备用编码”发送（不经还原），模型仍能按编号对应；用于判断 P0 失败时的备用方案是否可行 |
| 12 | 合法的最大负载 | 一条消息带 10 张图片、合计刚好不超过 12 MiB（如 3 张接近 4 MiB 加 7 张小图）：发送成功；会话文件能被 pi 和 pi-pane 的只读解析正常读取；单行 JSONL 大小、`get_entries` 的响应时间和服务端内存在可接受范围内（记录数值，据此调整上限） |
| 13 | 超限必须拒绝 | 单张缩放后仍超过 4 MiB、第 11 张图片、合计超过 12 MiB（如 4 张接近 4 MiB 的图片）三种情况都在浏览器端被拦下并说明原因；绕过浏览器直接调用接口时服务端同样拒绝，不发给 pi |
| 14 | 停止时取回 | 运行中排队两条带图片的 steer 后点“停止”：两条消息连同图片回到输入框，顺序不变 |

任何一项不通过，先记录 pi 的实际行为，再决定调整编码方式、改用其他路径，或推动上游修改。
