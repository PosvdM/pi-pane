// pane P0 #14：Vite + Preact 骨架加 Markdown 渲染（markdown-it）、代码高亮（highlight.js）和 CSP 后的 gzip 体积。
// 构建三个高亮语言集合的变体；主方案为 common。构建产物在 CSP 头下用浏览器加载，确认没有 CSP 违规。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { cspFor } from '../lib/auth-server.mjs';
import { probe, launch } from '../lib/browsers.mjs';
import { note } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'bundle');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const BUDGET = 300 * 1024;
const VARIANTS = ['common', 'min', 'full'];

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function measure(dist) {
  const files = listFiles(dist).map((p) => {
    const buf = readFileSync(p);
    return {
      file: path.relative(dist, p),
      raw: buf.length,
      gzip6: zlib.gzipSync(buf).length,
      gzip9: zlib.gzipSync(buf, { level: 9 }).length,
      brotli: zlib.brotliCompressSync(buf).length,
    };
  });
  const sum = (k) => files.reduce((a, f) => a + f[k], 0);
  return { files, total: { raw: sum('raw'), gzip6: sum('gzip6'), gzip9: sum('gzip9'), brotli: sum('brotli') } };
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

test('pane #14 前端打包体积', { timeout: 300_000, skip: !existsSync(VITE) && '未安装依赖（先在本目录运行 npm install）' }, async (t) => {
  const results = {};
  for (const v of VARIANTS) {
    const r = spawnSync(process.execPath, [VITE, 'build', '--config', path.join(BUNDLE, 'vite.config.js')], {
      cwd: ROOT,
      env: { ...process.env, P0_HLJS: v },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const dist = path.join(BUNDLE, `dist-${v}`);
    const m = measure(dist);
    results[v] = m;
    note(t, `size-${v}`, {
      total: Object.fromEntries(Object.entries(m.total).map(([k, n]) => [k, kib(n)])),
      files: m.files.map((f) => `${f.file}: raw ${kib(f.raw)}, gzip ${kib(f.gzip6)}`),
    });
  }
  // CSP 前提：没有内联脚本；产物里没有 eval / new Function
  const html = readFileSync(path.join(BUNDLE, 'dist-common', 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attrs, body]) => !/\bsrc=/.test(attrs) || body.trim());
  assert.equal(inline.length, 0, 'no inline script');
  const js = listFiles(path.join(BUNDLE, 'dist-common')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const evalHits = { eval: (js.match(/\beval\s*\(/g) ?? []).length, newFunction: (js.match(/new Function\s*\(/g) ?? []).length };
  note(t, 'eval-scan', evalHits);
  note(t, 'budget', { common: `${kib(results.common.total.gzip6)} / ${kib(BUDGET)}`, min: kib(results.min.total.gzip6), full: kib(results.full.total.gzip6) });
  assert.ok(results.common.total.gzip6 < BUDGET, 'common variant within 300 KiB gzip');
});

function serveDist(dist) {
  return new Promise((resolve) => {
    let port;
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      const file = path.join(dist, p === '/' ? 'index.html' : p);
      if (!file.startsWith(dist) || !existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': cspFor(port), 'X-Content-Type-Options': 'nosniff' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    });
  });
}

test('pane #14 构建产物在 CSP 下运行（Chrome、WebKit）', { timeout: 180_000 }, async (t) => {
  const dist = path.join(BUNDLE, 'dist-common');
  for (const name of ['chrome', 'webkit']) {
    await t.test(name, { timeout: 60_000 }, async (st) => {
      if (!existsSync(path.join(dist, 'index.html'))) return st.skip('先运行体积测试生成 dist-common');
      const p = await probe(name);
      if (!p.ok) return st.skip(`未测：${p.reason}`);
      const srv = await serveDist(dist);
      const b = await launch(name);
      try {
        const tab = await b.newTab();
        await tab.goto(`${srv.origin}/`);
        const html = await tab.call('rendered');
        const violations = await tab.call('violations');
        const xss = await tab.call('xss');
        const checks = {
          violations,
          xss,
          highlighted: /hljs-keyword/.test(html),
          rawHtmlEscaped: html.includes('&lt;img'),
          noJavascriptHref: !/href="javascript:/i.test(html),
          noDataHref: !/href="data:/i.test(html),
          remoteImageAsLink: html.includes('远程图片：tracker.example.net') && !/<img/i.test(html),
          externalRel: /<a href="https:\/\/example\.com\/pi" target="_blank" rel="noopener noreferrer">/.test(html),
        };
        note(st, 'csp-render', checks);
        assert.deepEqual(violations, []);
        assert.equal(xss, false);
        for (const [k, v] of Object.entries(checks)) if (typeof v === 'boolean' && k !== 'xss') assert.equal(v, true, k);
      } finally {
        await b.close();
        await srv.close();
      }
    });
  }
});
