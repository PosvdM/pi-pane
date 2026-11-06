// 浏览器驱动（playwright-core）。目标浏览器为本机 Chrome；Playwright 下载的 WebKit 构建只作可选参考
// （P0_BROWSERS=chrome,webkit），不进入结论。所有浏览器都用临时配置目录，不碰主人的配置。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
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

/** 测试用的主机名映射：rebind.test 模拟 DNS 重绑定；insecure.test 用于非安全上下文。只对 Chrome 生效。 */
export const MAPPED_HOSTS = ['rebind.test', 'insecure.test'];

const CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  linux: '/opt/google/chrome/chrome',
};

export const TARGETS = ['chrome', 'webkit'];

export const TARGET_NOTES = {
  chrome: '本机 Google Chrome（playwright-core channel=chrome，headless）',
  webkit: 'Playwright 下载的 WebKit 构建（可选参考，不等于 Safari，不计入结论）',
};

function rm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

/** 浏览器是否可用；不可用时返回原因。 */
export async function probe(name) {
  if (!pw) return { ok: false, reason: `未安装 playwright-core（先在本目录运行 npm install）：${pwError?.message}` };
  if (name === 'chrome') {
    const exe = CHROME[platform()];
    if (!exe || !existsSync(exe)) return { ok: false, reason: `本机未安装 Chrome（找不到 ${exe}）` };
    return { ok: true };
  }
  if (name === 'webkit') {
    if (!existsSync(pw.webkit.executablePath())) return { ok: false, reason: '未下载 Playwright 的 WebKit（运行 npm run browsers）' };
    return { ok: true };
  }
  return { ok: false, reason: `未知浏览器 ${name}` };
}

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
 * - 'private'：off-the-record 的 BrowserContext（Chrome 无痕窗口使用的机制；WebKit 为临时 context）。
 * profileDir：传入则复用（用于测试重启后密钥是否保留），否则新建并在 close 时删除。
 */
export async function launch(name, { mode = 'normal', profileDir } = {}) {
  const own = !profileDir;
  const dir = profileDir ?? mkdtempSync(path.join(tmpdir(), `p0-f-${name}-`));
  const bt = name === 'webkit' ? pw.webkit : pw.chromium;
  const opts = { headless: true };
  if (name === 'chrome') {
    opts.channel = 'chrome';
    // --no-proxy-server：本机可能设有系统代理，映射的测试域名不能被发往代理。
    opts.args = ['--no-proxy-server', `--host-resolver-rules=${MAPPED_HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`];
  }
  let context;
  let browser = null;
  try {
    if (mode === 'private') {
      browser = await bt.launch(opts);
      context = await browser.newContext();
    } else {
      context = await bt.launchPersistentContext(dir, opts);
    }
  } catch (e) {
    if (own) rm(dir);
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
