import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import busboy from "busboy";
import { acquireInstanceLock, ensurePrivateDir, locatePi, type HeldLock } from "pi-hostkit";
import { negotiateProtocol, type StreamCursor } from "@pi-pane/plugin-api";
import { AuthStore, checkOrigin } from "./auth.js";
import { AssetStore, MAX_IMAGE_BYTES } from "./assets.js";
import { BridgeBroker } from "./bridge.js";
import { assert, PaneError } from "./errors.js";
import { Sessions, type SessionManagerOptions } from "./sessions.js";
import { PiStore } from "./store.js";
import { TrustDecisions } from "./trust.js";

export interface PaneServerOptions extends Partial<Omit<SessionManagerOptions, "pi" | "bridgeUrl" | "instanceId" | "extensionPath">> {
  home: string; piPath?: string; port?: number; agentDir?: string; extensionPath?: string; webRoot?: string;
}
interface Client {
  ws: WebSocket; id: string; credential?: string; state: "pending" | "authed" | "closed";
  subscriptions: Map<string, () => void>; pending: any[]; pendingBytes: number; needsResync: Map<string, any>;
}
async function jsonBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<any> {
  assert(req.headers["content-type"]?.split(";")[0] === "application/json", "contentType", "请求必须使用 application/json", 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert(size <= limit, "bodyTooLarge", "请求体超过大小上限", 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); assert(value && typeof value === "object" && !Array.isArray(value), "invalidBody", "请求体必须是 JSON 对象"); return value; }
  catch (error) { if (error instanceof PaneError) throw error; throw new PaneError("invalidJson", "请求体不是合法 JSON"); }
}
function sendJson(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
function bearer(req: IncomingMessage): string { return req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ?? ""; }
async function upload(req: IncomingMessage): Promise<{ image: Buffer; mimeType: string; thumb: Buffer }> {
  return new Promise((resolve, reject) => {
    let image: Buffer | undefined; let thumb: Buffer | undefined; let mimeType = ""; let failed: unknown;
    let parser;
    try { parser = busboy({ headers: req.headers, limits: { files: 3, parts: 3, fields: 0, fileSize: MAX_IMAGE_BYTES + 1, headerPairs: 64 } }); }
    catch { reject(new PaneError("invalidUpload", "图片上传格式无效")); return; }
    const names = new Set<string>();
    parser.on("file", (name, stream, info) => {
      if (!["image", "thumb"].includes(name) || names.has(name)) failed = new PaneError("invalidUpload", "上传必须包含 image 和 thumb 各一份"); names.add(name);
      const parts: Buffer[] = []; let size = 0;
      stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (name === "thumb" ? 512 * 1024 : MAX_IMAGE_BYTES)) failed = new PaneError("imageTooLarge", "上传图片或缩略图超过大小上限", 413); else parts.push(chunk); });
      stream.on("limit", () => { failed = new PaneError("imageTooLarge", "上传图片超过大小上限", 413); });
      stream.on("error", reject);
      stream.on("end", () => { if (name === "image") { image = Buffer.concat(parts); mimeType = info.mimeType; } else thumb = Buffer.concat(parts); });
    });
    for (const event of ["partsLimit", "filesLimit", "fieldsLimit"]) parser.on(event, () => { failed = new PaneError("invalidUpload", "上传部分数量无效"); });
    parser.on("error", reject); req.on("error", reject);
    parser.on("close", () => { if (failed) reject(failed); else if (!image || !thumb) reject(new PaneError("invalidUpload", "上传必须包含 image 和 thumb")); else resolve({ image, mimeType, thumb }); });
    req.pipe(parser);
  });
}
export class PaneServer {
  readonly auth = new AuthStore(); readonly broker = new BridgeBroker(); readonly assets: AssetStore;
  readonly sessions: Sessions; readonly trust: TrustDecisions; readonly http: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  private readonly clients = new Set<Client>(); private port = 0; private lock?: HeldLock; private sweep?: ReturnType<typeof setInterval>; private closed = false;
  private constructor(private readonly options: PaneServerOptions, private readonly store: PiStore) {
    this.assets = new AssetStore(options.home);
    this.trust = new TrustDecisions(store, () => [...this.clients].some((c) => c.state === "authed"), (request) => this.broadcast({ type: "project_trust", request }));
    this.sessions = new Sessions(this.assets, store, this.trust, this.broker, {
      ...options, pi: store.install, instanceId: this.auth.instanceId, bridgeUrl: "", extensionPath: options.extensionPath ?? fileURLToPath(new URL("../../bridge-extension/dist/index.js", import.meta.url)),
    }, (id, request) => { for (const client of this.clients) if (client.subscriptions.has(id)) this.push(client, { type: "ui_request", ref: { source: "pane", id }, request }); });
    this.http = http.createServer((req, res) => { void this.request(req, res).catch((error) => this.error(res, error)); });
    this.http.requestTimeout = 65000; this.http.headersTimeout = 10000; this.http.keepAliveTimeout = 5000;
    this.http.on("upgrade", (req, socket, head) => {
      if (!checkOrigin(req.headers, this.port) || req.url !== "/ws") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws));
    });
    this.auth.onRevoke((credential) => { for (const client of this.clients) if (client.credential === credential) this.closeClient(client, 4403, "凭证已失效"); });
  }
  static async start(options: PaneServerOptions): Promise<PaneServer> {
    await ensurePrivateDir(options.home);
    const pi = await locatePi(options.piPath ? { piPath: options.piPath } : {}); assert(pi.supported, "piVersion", `不支持的 pi 版本：${pi.version}`);
    const home = options.env?.HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
    const agentDir = options.agentDir ?? options.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent");
    const server = new PaneServer(options, new PiStore(pi, agentDir, path.join(options.home, "tmp"), options.env ?? process.env));
    try {
      const lock = await acquireInstanceLock("pi-pane", options.home); assert(lock, "instanceBusy", "同一数据目录已有 pi-pane 服务端", 409); server.lock = lock;
      await server.sessions.recover();
      await new Promise<void>((resolve, reject) => { server.http.once("error", reject); server.http.listen(options.port ?? 4319, "127.0.0.1", () => { server.http.off("error", reject); resolve(); }); });
      server.port = (server.http.address() as { port: number }).port;
      // 驱动延迟到第一次发送才启动，监听端口确定后设置回连地址。
      server.sessions.setBridgeUrl(server.origin);
      server.sweep = setInterval(() => { server.auth.sweep(); try { server.assets.sweep(); } catch { /* 清理故障不影响会话；下次清理重试。 */ } }, 60000); server.sweep.unref();
      return server;
    } catch (error) { await server.close().catch(() => {}); throw error; }
  }
  get origin(): string { return `http://127.0.0.1:${this.port}`; }
  private headers(res: ServerResponse): void {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; connect-src 'self' ws://127.0.0.1:${this.port}`);
  }
  private error(res: ServerResponse, error: any): void {
    if (res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, Number.isInteger(error.status) ? error.status : 500, { error: error.code ?? "internalError", message: error.status ? error.message : "服务端处理失败", instanceId: this.auth.instanceId });
  }
  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.headers(res); assert(checkOrigin(req.headers, this.port), "badOrigin", "只允许规范的本机来源", 403);
    const url = new URL(req.url ?? "/", this.origin); const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/api/instance") { sendJson(res, 200, { instanceId: this.auth.instanceId, paneProtocol: 1 }); return; }
    if (req.method === "POST" && pathname === "/api/auth/pair") { sendJson(res, 200, this.auth.pair((await jsonBody(req, 4096)).code)); return; }
    if (req.method === "POST" && pathname.startsWith("/bridge/")) {
      const body = await jsonBody(req, 65536);
      if (pathname === "/bridge/launch") sendJson(res, 200, this.broker.launch(body.ticket));
      else if (pathname === "/bridge/event") sendJson(res, 200, await this.broker.event(bearer(req), body));
      else throw new PaneError("notFound", "接口不存在", 404);
      return;
    }
    if (pathname.startsWith("/api/")) {
      const credential = bearer(req); assert(this.auth.useCredential(credential), "unauthorized", "请重新配对", 401);
      if (req.method === "POST" && pathname === "/api/ws-ticket") { sendJson(res, 200, { ticket: this.auth.issueTicket(credential) }); return; }
      if (req.method === "POST" && pathname === "/api/auth/logout") { this.auth.revoke(credential); sendJson(res, 200, { status: "done" }); return; }
      if (req.method === "POST" && pathname === "/api/auth/code") { sendJson(res, 200, { code: this.auth.issuePairCode() }); return; }
      if (req.method === "GET" && pathname === "/api/sessions") { sendJson(res, 200, { sessions: await this.sessions.list() }); return; }
      if (req.method === "GET" && pathname === "/api/trust") { sendJson(res, 200, { requests: this.trust.list() }); return; }
      const trust = pathname.match(/^\/api\/trust\/([^/]+)$/);
      if (req.method === "POST" && trust) {
        const body = await jsonBody(req); sendJson(res, 200, await this.sessions.ledger.execute(body.requestId, { path: pathname, body }, async () => { this.trust.answer(trust[1], body.decision); return { status: "done" }; })); return;
      }
      if (req.method === "POST" && pathname === "/api/sessions/open") {
        const body = await jsonBody(req); sendJson(res, 200, await this.sessions.ledger.execute(body.requestId, { path: pathname, body }, () => this.sessions.open(body))); return;
      }
      const route = pathname.match(/^\/api\/sessions\/([^/]+)\/(snapshot|history|control|query|ui)$/);
      if (route) {
        const id = decodeURIComponent(route[1]); const operation = route[2];
        if (req.method === "GET" && operation === "snapshot") { sendJson(res, 200, this.sessions.snapshot(id)); return; }
        if (req.method === "GET" && operation === "history") { sendJson(res, 200, this.sessions.history(id, url.searchParams.get("before") ?? "", Number(url.searchParams.get("limit") ?? 50))); return; }
        if (req.method === "POST" && operation === "control") { sendJson(res, 200, await this.sessions.command(id, await jsonBody(req))); return; }
        if (req.method === "POST" && operation === "query") { sendJson(res, 200, await this.sessions.query(id, (await jsonBody(req)).type)); return; }
        if (req.method === "POST" && operation === "ui") { const body = await jsonBody(req); sendJson(res, 200, await this.sessions.ledger.execute(body.requestId, { path: pathname, body }, async () => this.sessions.respondUi(id, body))); return; }
      }
      if (req.method === "POST" && pathname === "/api/assets") {
        const parts = await upload(req); const id = req.headers["x-request-id"];
        assert(typeof id === "string", "invalidRequestId", "上传必须提供 X-Request-Id");
        const { hashId } = await import("./assets.js");
        sendJson(res, 200, await this.sessions.ledger.execute(id, { path: pathname, image: hashId(parts.image), thumb: hashId(parts.thumb), mimeType: parts.mimeType }, async () => this.assets.upload(parts.image, parts.mimeType, parts.thumb))); return;
      }
      if (req.method === "POST" && pathname === "/api/assets/touch") {
        const body = await jsonBody(req); assert(Array.isArray(body.assetIds) && body.assetIds.length <= 10000, "invalidAssetIds", "图片标识列表无效");
        sendJson(res, 200, await this.sessions.ledger.execute(body.requestId, { path: pathname, body }, async () => this.assets.touch(body.assetIds))); return;
      }
      const asset = pathname.match(/^\/api\/(assets|blobs)\/(sha256-[a-f0-9]{64})(\/thumb)?$/);
      if (req.method === "GET" && asset) {
        let content;
        if (asset[1] === "assets") content = this.assets.asset(asset[2], !!asset[3]);
        else {
          try { content = this.assets.blob(asset[2]); }
          catch (error) { if (error instanceof PaneError && error.code === "blobMissing") { await this.sessions.reextractBlobs(); content = this.assets.blob(asset[2]); } else throw error; }
        }
        const safe = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(content.mimeType);
        res.setHeader("Content-Type", safe ? content.mimeType : "application/octet-stream"); if (!safe) res.setHeader("Content-Disposition", "attachment"); res.end(content.data); return;
      }
      throw new PaneError("notFound", "接口不存在", 404);
    }
    if (req.method === "GET" && this.options.webRoot) {
      const root = await import("node:fs/promises").then((fs) => fs.realpath(this.options.webRoot!));
      const target = path.resolve(root, "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
      assert(target.startsWith(root + path.sep), "notFound", "文件不存在", 404);
      const actual = await import("node:fs/promises").then((fs) => fs.realpath(target)); assert(actual.startsWith(root + path.sep), "notFound", "文件不存在", 404);
      assert((await stat(actual)).isFile(), "notFound", "文件不存在", 404);
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
      res.setHeader("Content-Type", types[path.extname(actual)] ?? "application/octet-stream"); res.end(await readFile(actual)); return;
    }
    throw new PaneError("notFound", "M1 只提供服务端接口，Web 界面在 M2 实现", 404);
  }
  private connection(ws: WebSocket): void {
    const client: Client = { ws, id: randomUUID(), state: "pending", subscriptions: new Map(), pending: [], pendingBytes: 0, needsResync: new Map() }; this.clients.add(client);
    const timeout = setTimeout(() => this.closeClient(client, 4401, "首帧鉴权超时"), 5000); timeout.unref();
    const flush = setInterval(() => this.flush(client), 25); flush.unref();
    ws.on("error", () => this.closeClient(client, 1011, "连接故障"));
    ws.on("close", () => { clearTimeout(timeout); clearInterval(flush); client.state = "closed"; for (const off of client.subscriptions.values()) off(); client.subscriptions.clear(); this.clients.delete(client); });
    ws.on("message", (raw, binary) => {
      if (client.state === "closed") return;
      try {
        assert(!binary, "invalidFrame", "只接受 JSON 文本帧"); const message = JSON.parse(raw.toString());
        if (client.state === "pending") {
          assert(message.type === "auth" && typeof message.ticket === "string", "invalidFirstFrame", "第一帧必须是 ticket 鉴权");
          const credential = this.auth.redeemTicket(message.ticket); const paneProtocol = negotiateProtocol(message.paneProtocol === undefined ? [1, 1] : message.paneProtocol);
          client.credential = credential; client.state = "authed"; clearTimeout(timeout);
          this.push(client, { type: "banners", banners: [], paneProtocol, connectionId: client.id }); return;
        }
        assert(this.auth.useCredential(client.credential!), "unauthorized", "凭证已失效");
        if (message.type === "subscribe") {
          assert(message.ref?.source === "pane" && typeof message.ref.id === "string", "invalidRef", "只支持主会话订阅");
          client.subscriptions.get(message.ref.id)?.();
          const off = this.sessions.subscribe(message.ref.id, message.after as StreamCursor, (event) => this.push(client, { type: "session", ...event }));
          client.subscriptions.set(message.ref.id, off);
        } else if (message.type === "unsubscribe") { client.subscriptions.get(message.ref?.id)?.(); client.subscriptions.delete(message.ref?.id); }
        else if (message.type === "ping") this.push(client, { type: "pong" });
        else throw new PaneError("invalidFrame", "不支持此 WebSocket 消息");
      } catch { this.closeClient(client, 4401, "鉴权或消息格式无效"); }
    });
  }
  private closeClient(client: Client, code: number, reason: string): void { if (client.state === "closed") return; client.state = "closed"; client.pending = []; client.needsResync.clear(); client.ws.close(code, reason); }
  private broadcast(message: unknown): void { for (const client of this.clients) this.push(client, message); }
  private push(client: Client, message: any): void {
    if (client.state !== "authed" || client.ws.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(message);
    if (!client.pending.length && client.ws.bufferedAmount < 1024 * 1024) { client.ws.send(text); return; }
    if (message.type === "session" && client.needsResync.size) { client.needsResync.set(message.ref.id, { ...message, event: { type: "resync" } }); return; }
    const last = client.pending.at(-1); const delta = message.event?.assistantMessageEvent; const prev = last?.event?.assistantMessageEvent;
    if (message.type === "session" && last?.ref?.id === message.ref.id && message.cursor?.epoch === last.cursor?.epoch && delta?.type === "text_delta" && prev?.type === "text_delta" && delta.contentIndex === prev.contentIndex) {
      client.pendingBytes -= Buffer.byteLength(JSON.stringify(last));
      const merged = { ...message, event: { ...message.event, assistantMessageEvent: { ...delta, delta: prev.delta + delta.delta } } };
      client.pending[client.pending.length - 1] = merged; client.pendingBytes += Buffer.byteLength(JSON.stringify(merged));
    } else { client.pending.push(message); client.pendingBytes += Buffer.byteLength(text); }
    if (client.pendingBytes + client.ws.bufferedAmount > 8 * 1024 * 1024) {
      for (const item of client.pending) if (item.type === "session") client.needsResync.set(item.ref.id, { ...item, event: { type: "resync" } });
      client.pending = client.pending.filter((item) => item.type !== "session"); client.pendingBytes = client.pending.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), 0);
      if (client.pendingBytes > 1024 * 1024) this.closeClient(client, 1013, "客户端处理过慢，请重新连接");
    }
  }
  private flush(client: Client): void {
    if (client.state !== "authed" || client.ws.bufferedAmount >= 1024 * 1024) return;
    for (const item of client.pending.splice(0)) { client.pendingBytes -= Buffer.byteLength(JSON.stringify(item)); client.ws.send(JSON.stringify(item)); }
    for (const item of client.needsResync.values()) client.ws.send(JSON.stringify(item)); client.needsResync.clear();
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; clearInterval(this.sweep);
    for (const client of this.clients) { this.closeClient(client, 1001, "服务端停止"); client.ws.terminate(); }
    let error: unknown;
    try { await this.sessions.close(); } catch (cause) { error = cause; }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.http.listening) { this.http.closeAllConnections(); await new Promise<void>((resolve) => this.http.close(() => resolve())); }
    await this.lock?.release(); if (error) throw error;
  }
}
