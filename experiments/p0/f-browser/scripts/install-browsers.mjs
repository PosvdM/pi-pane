// 把 Playwright 的 Firefox、WebKit 下载到本目录的 .browsers/，不写入全局缓存。跨平台，替代 shell 里的环境变量写法。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'install', 'firefox', 'webkit'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(ROOT, '.browsers') },
});
process.exit(r.status ?? 1);
