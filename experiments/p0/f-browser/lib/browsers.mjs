// 浏览器驱动：本机 Chrome/Edge 与 Playwright 下载的 Firefox、WebKit 走 playwright-core，
// Safari 走 safaridriver（W3C WebDriver，零依赖）。所有浏览器都用临时配置目录，不碰主人的配置。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, '.browsers');

let pw = null;
let pwError = null;
try {
  pw = await import('playwright-core');
} catch (e) {
  pwError = e;
}

export class Skip extends Error {}

/** 测试用的主机名映射：rebind.test 模拟 DNS 重绑定；insecure.test 用于非安全上下文。 */
export const MAPPED_HOSTS = ['rebind.test', 'insecure.test'];

const APPS = {
  darwin: {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  },
  win32: {
    chrome: path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    edge: path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  },
  linux: { chrome: '/opt/google/chrome/chrome', edge: '/opt/microsoft/msedge/msedge' },
};

export const TARGETS = ['chrome', 'edge', 'firefox', 'safari', 'webkit'];

export const TARGET_NOTES = {
  chrome: '本机 Google Chrome（playwright-core channel=chrome，headless）',
  edge: '本机 Microsoft Edge（channel=msedge）',
  firefox: 'Playwright 下载的 Firefox 构建（带 Juggler 补丁，非官方发行版）',
  safari: '本机 Safari，经 safaridriver',
  webkit: 'Playwright 下载的 WebKit 构建（仅作参考，不等于 Safari）',
};

function tmpProfile(name) {
  return mkdtempSync(path.join(tmpdir(), `p0-f-${name}-`));
}

function rm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

/** 浏览器是否可用；不可用时返回原因。 */
export async function probe(name) {
  if (name === 'safari') {
    if (platform() !== 'darwin') return { ok: false, reason: '只在 macOS 上有 Safari' };
    return { ok: true };
  }
  if (!pw) return { ok: false, reason: `未安装 playwright-core（先在本目录运行 npm install）：${pwError?.message}` };
  if (name === 'chrome' || name === 'edge') {
    const exe = APPS[platform()]?.[name];
    if (!exe || !existsSync(exe)) return { ok: false, reason: `本机未安装（找不到 ${exe}）` };
    return { ok: true };
  }
  const bt = name === 'firefox' ? pw.firefox : pw.webkit;
  const exe = bt.executablePath();
  if (!existsSync(exe)) return { ok: false, reason: `未下载 Playwright 的 ${name}（运行 npm run browsers）` };
  return { ok: true };
}

// ---------------------------------------------------------------- Playwright

class PwTab {
  constructor(page) {
    this.page = page;
  }
  async goto(url) {
    const res = await this.page.goto(url);
    return { status: res?.status() ?? null };
  }
  async call(fn, ...args) {
    await this.page.waitForFunction(() => window.__f, null, { timeout: 10000 });
    return this.page.evaluate(([n, a]) => window.__f[n](...a), [fn, args]);
  }
  async text() {
    return this.page.evaluate(() => document.body?.innerText ?? '');
  }
  async reload() {
    await this.page.reload();
  }
  async close() {
    await this.page.close();
  }
}

/**
 * 启动浏览器。mode：
 * - 'normal'：持久配置目录（临时目录），相当于普通窗口；
 * - 'private'：Chrome/Edge 用 off-the-record 的 BrowserContext（与无痕窗口相同的机制），
 *   Firefox 用 browser.privatebrowsing.autostart，WebKit 用临时 context；Safari 不支持。
 * profileDir：传入则复用（用于测试重启后密钥是否保留），否则新建并在 close 时删除。
 */
export async function launch(name, { mode = 'normal', profileDir } = {}) {
  if (name === 'safari') return launchSafari({ mode });
  const own = !profileDir;
  const dir = profileDir ?? tmpProfile(name);
  const bt = name === 'firefox' ? pw.firefox : name === 'webkit' ? pw.webkit : pw.chromium;
  const opts = { headless: true };
  if (name === 'chrome') opts.channel = 'chrome';
  if (name === 'edge') opts.channel = 'msedge';
  if (name === 'chrome' || name === 'edge') {
    // --no-proxy-server：本机可能设有系统代理，映射的测试域名不能被发往代理。
    opts.args = ['--no-proxy-server', `--host-resolver-rules=${MAPPED_HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`];
  }
  if (name === 'firefox') {
    opts.firefoxUserPrefs = {
      'network.dns.localDomains': MAPPED_HOSTS.join(','),
      'network.proxy.type': 0,
      'dom.disable_open_during_load': false,
      ...(mode === 'private' ? { 'browser.privatebrowsing.autostart': true } : {}),
    };
  }
  let context;
  let browser = null;
  try {
    if (mode === 'private' && name !== 'firefox') {
      browser = await bt.launch(opts);
      context = await browser.newContext();
    } else {
      context = await bt.launchPersistentContext(dir, opts);
    }
  } catch (e) {
    if (own) rm(dir);
    if (/Failed to launch the browser process/.test(e.message)) {
      const why = e.message.split('\n').filter((l) => /\[err\]|exitCode/.test(l)).slice(0, 3).join(' | ');
      throw new Skip(`未测：浏览器无法启动（${why.trim()}）`);
    }
    throw e;
  }
  const pages = context.pages();
  return {
    name,
    mode,
    profileDir: dir,
    async newTab() {
      const page = pages.length ? pages.shift() : await context.newPage();
      return new PwTab(page);
    },
    async close({ keepProfile = false } = {}) {
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      if (own && !keepProfile) rm(dir);
    },
  };
}

// ---------------------------------------------------------------- Safari

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function launchSafari({ mode }) {
  if (mode === 'private') throw new Skip('safaridriver 没有无痕会话选项，需主人手动在 Safari 无痕窗口里测试');
  const port = await freePort();
  const child = spawn('safaridriver', ['-p', String(port)], { stdio: 'ignore', detached: platform() !== 'win32' });
  const killDriver = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  const base = `http://127.0.0.1:${port}`;
  const wd = async (method, p, body) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (j?.value?.error) {
      const e = new Error(`${j.value.error}: ${j.value.message}`);
      e.wd = j.value;
      throw e;
    }
    return j.value;
  };
  let session;
  for (let i = 0; i < 50; i++) {
    try {
      session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
      break;
    } catch (e) {
      if (e.wd) {
        killDriver();
        if (/Allow remote automation/i.test(e.wd.message)) {
          throw new Skip(`需主人手动：Safari 未开启“允许远程自动化”。safaridriver 原文：${e.wd.message}`);
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100)); // 驱动尚未监听
    }
  }
  if (!session) {
    killDriver();
    throw new Error('safaridriver did not start');
  }
  const sid = session.sessionId;
  let first = await wd('GET', `/session/${sid}/window`);
  let current = first;
  const sw = async (h) => {
    if (current !== h) {
      await wd('POST', `/session/${sid}/window`, { handle: h });
      current = h;
    }
  };
  class SafariTab {
    constructor(handle) {
      this.handle = handle;
    }
    async goto(url) {
      await sw(this.handle);
      await wd('POST', `/session/${sid}/url`, { url });
      return { status: null };
    }
    async call(fn, ...args) {
      await sw(this.handle);
      const script =
        'const done = arguments[arguments.length - 1]; const [n, a] = arguments;' +
        'const go = () => window.__f ? Promise.resolve(window.__f[n](...a)).then(v => done({ v }), e => done({ e: String(e) })) : setTimeout(go, 50);' +
        'go();';
      const r = await wd('POST', `/session/${sid}/execute/async`, { script, args: [fn, args] });
      if (r && 'e' in r) throw new Error(r.e);
      return r?.v;
    }
    async text() {
      await sw(this.handle);
      return wd('POST', `/session/${sid}/execute/sync`, { script: 'return document.body ? document.body.innerText : ""', args: [] });
    }
    async reload() {
      await sw(this.handle);
      await wd('POST', `/session/${sid}/refresh`, {});
    }
    async close() {
      await sw(this.handle);
      await wd('DELETE', `/session/${sid}/window`);
      current = null;
    }
  }
  let firstUsed = false;
  return {
    name: 'safari',
    mode,
    async newTab() {
      if (!firstUsed) {
        firstUsed = true;
        return new SafariTab(first);
      }
      const w = await wd('POST', `/session/${sid}/window/new`, { type: 'tab' });
      return new SafariTab(w.handle);
    },
    async close() {
      await wd('DELETE', `/session/${sid}`).catch(() => {});
      killDriver();
    },
  };
}
