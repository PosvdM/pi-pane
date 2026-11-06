import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
  return Buffer.concat([length, data, crc]);
}

// 生成红方块、蓝圆和白底黑色 C，不依赖图像库。
export function png(kind = 0, width = 24, height = 24, targetSize) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const circle = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (Math.min(width, height) * 0.42) ** 2;
    const c = (x < width * 0.3 || y < height * 0.25 || y > height * 0.75) && x > width * 0.15 && x < width * 0.8;
    const color = kind === 0 ? [255, 0, 0] : kind === 1 && circle ? [0, 0, 255] : kind === 2 && c ? [0, 0, 0] : [255, 255, 255];
    rows.set(color, y * (width * 3 + 1) + 1 + x * 3);
  }
  const parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows))];
  const end = chunk('IEND', Buffer.alloc(0));
  const size = parts.reduce((n, part) => n + part.length, 0) + end.length;
  if (targetSize) {
    if (targetSize < size + 14) throw new Error('targetSize is too small');
    const pad = Buffer.alloc(targetSize - size - 12, 0x61); pad[1] = 0;
    parts.push(chunk('tEXt', pad));
  }
  return Buffer.concat([...parts, end]);
}
export const image = (kind = 0, width, height, size) => ({ type: 'image', data: png(kind, width, height, size).toString('base64'), mimeType: 'image/png' });
export const images = [0, 1, 2].map(kind => image(kind));
export function encode(imgs = images, texts = imgs.map((_, i) => `段${i + 1}`), nonce = 'abc123') {
  return { message: imgs.map((_, i) => `${texts[i] ?? ''}⟦pane-img:${nonce}:${i + 1}⟧`).join('') + (texts[imgs.length] ?? '末尾'), images: imgs };
}
export function restore(message) {
  if (message.role !== 'user' || !Array.isArray(message.content)) return {};
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text.includes('⟦pane-img:')) return {};
  const marks = [...text.matchAll(/⟦pane-img:([a-z0-9]{6,8}):(\d+)⟧/g)];
  const imgs = message.content.filter(b => b.type === 'image');
  if (!marks.length || marks.length !== imgs.length || marks.some((m, i) => m[1] !== marks[0][1] || Number(m[2]) !== i + 1)) return { invalid: true };
  let offset = 0;
  const content = [];
  for (const [i, mark] of marks.entries()) {
    content.push({ type: 'text', text: text.slice(offset, mark.index) + `[Image #${i + 1}]` }, imgs[i]);
    offset = mark.index + mark[0].length;
  }
  if (offset < text.length) content.push({ type: 'text', text: text.slice(offset) });
  return { message: { ...message, content } };
}

export function validateImages(imgs) {
  if (imgs.length > 10) return '图片不能超过 10 张';
  const sizes = imgs.map(i => Buffer.from(i.data, 'base64').length);
  if (sizes.some(s => s > 4 * 1024 * 1024)) return '单张图片不能超过 4 MiB';
  if (sizes.reduce((a, b) => a + b, 0) > 12 * 1024 * 1024) return '图片合计不能超过 12 MiB';
  return undefined;
}
export const signature = content => content.map(b => b.type === 'text' ? `T:${b.text}` : `I:${Buffer.from(b.data, 'base64').length}`);
