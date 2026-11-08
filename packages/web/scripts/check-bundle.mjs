// 检查前端打包体积：dist 中全部 HTML、JS、CSS 的 gzip 大小之和不超过 300 KiB（architecture.md 的设计约束）。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const LIMIT = 300 * 1024;
const dist = fileURLToPath(new URL("../dist", import.meta.url));
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (/\.(html|js|css)$/.test(entry.name)) result.push(full);
  }
  return result;
}
let total = 0;
for (const file of await files(dist)) {
  const size = gzipSync(await readFile(file), { level: 9 }).length;
  total += size;
  console.log(`${path.relative(dist, file)}\t${(size / 1024).toFixed(1)} KiB`);
}
console.log(`gzip 合计 ${(total / 1024).toFixed(1)} KiB，预算 ${LIMIT / 1024} KiB`);
if (total > LIMIT) {
  console.error("前端打包体积超过预算");
  process.exit(1);
}
