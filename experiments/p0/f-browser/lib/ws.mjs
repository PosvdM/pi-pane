// 零依赖的最小 WebSocket（RFC 6455）实现，只够本实验用：
// 服务端握手、文本帧、close、ping/pong；不支持分片和扩展。
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode, payload, { mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

/** 解析一个完整帧；数据不足时返回 null。 */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let key;
  if (masked) {
    if (buf.length < off + 4) return null;
    key = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= key[i % 4];
  return { opcode, payload, masked, rest: buf.subarray(off + len) };
}

/** 一条 WebSocket 连接（服务端或客户端视角）。事件：message(text)、close(code, reason)。 */
export class WsConnection extends EventEmitter {
  constructor(socket, { isClient = false } = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => this.#finish(1006, ''));
    socket.on('error', () => this.#finish(1006, ''));
  }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const f = decodeFrame(this.buf);
      if (!f) return;
      this.buf = f.rest;
      if (f.opcode === 0x1) this.emit('message', f.payload.toString('utf8'));
      else if (f.opcode === 0x8) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) this.close(code === 1005 ? 1000 : code, reason);
        this.#finish(code, reason);
        this.socket.end();
      } else if (f.opcode === 0x9) this.#write(encodeFrame(0xa, f.payload, { mask: this.isClient }));
    }
  }

  #write(b) {
    if (!this.socket.destroyed) this.socket.write(b);
  }

  #finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  send(text) {
    if (this.closed) return;
    this.#write(encodeFrame(0x1, text, { mask: this.isClient }));
  }

  close(code = 1000, reason = '') {
    if (this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(reason, 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#write(encodeFrame(0x8, p, { mask: this.isClient }));
    // 对端不回 close 时 1 秒后强制断开。
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

/** 完成服务端握手，返回连接。调用方已做过 Host/Origin 等检查。 */
export function acceptUpgrade(req, socket, head, extraHeaders = {}) {
  const key = req.headers['sec-websocket-key'];
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  const conn = new WsConnection(socket);
  if (head && head.length) socket.emit('data', head);
  return conn;
}

/** 拒绝握手：写一个普通 HTTP 响应后断开。 */
export function rejectUpgrade(socket, status, body, headers = {}) {
  const text = JSON.stringify(body);
  const lines = [
    `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Error'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(text)}`,
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.end(lines.join('\r\n') + '\r\n\r\n' + text);
}
