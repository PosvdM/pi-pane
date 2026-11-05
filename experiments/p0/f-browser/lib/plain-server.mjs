// 不做任何检查的静态服务器，模拟“同机其他 127.0.0.1 端口的服务”，
// 也用于在非安全上下文（非 loopback 的主机名）里加载设备密钥代码。
// /evil/* 来自 evil/，其他路径来自 public/。不设 CSP。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export async function startPlainServer({ port = 0, listen = '127.0.0.1' } = {}) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: req.url, host: req.headers.host });
    let file;
    if (url.pathname === '/evil/' || url.pathname === '/evil') file = path.join(ROOT, 'evil', 'index.html');
    else if (/^\/evil\/[a-z0-9-]+\.js$/.test(url.pathname)) file = path.join(ROOT, 'evil', url.pathname.slice(6));
    else if (url.pathname === '/') file = path.join(ROOT, 'public', 'index.html');
    else if (/^\/[a-z0-9-]+\.(js|html)$/.test(url.pathname)) file = path.join(ROOT, 'public', url.pathname.slice(1));
    try {
      if (!file) throw new Error('nf');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r, j) => {
    server.once('error', j);
    server.listen(port, listen, r);
  });
  const p = server.address().port;
  return {
    port: p,
    origin: `http://127.0.0.1:${p}`,
    log,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
