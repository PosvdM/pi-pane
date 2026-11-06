// 把 Playwright 的 WebKit（可选参考）下载到本目录的 .browsers/，不写入全局缓存。Chrome 用本机安装的，不需要下载。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'install', 'webkit'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(ROOT, '.browsers') },
});
process.exit(r.status ?? 1);
