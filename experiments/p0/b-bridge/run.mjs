import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pi-p0-b-run-'));
const logPath = join(root, 'verification.tap');
const auditPath = join(root, 'process-audit.txt');
const tests = (await readdir(here)).filter(path => path.endsWith('.test.mjs')).map(path => join(here, path));
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2), ...tests], { stdio: ['ignore', 'pipe', 'pipe'] });
let pending = Promise.resolve();
const record = chunk => {
  process.stdout.write(chunk);
  pending = pending.then(() => appendFile(logPath, chunk));
};
child.stdout.on('data', record);
child.stderr.on('data', record);
const exit = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
await pending;
const output = await readFile(logPath, 'utf8');
const pids = [...new Set([...output.matchAll(/"(?:piPid|pid)":(\d+)/g)].map(match => Number(match[1])))];
const alive = pids.filter(pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
});
await writeFile(auditPath, `Run directory: ${root}\nRecorded pi/MCP PIDs: ${pids.join(', ')}\nAlive after test cleanup: ${JSON.stringify(alive)}\nNo process was terminated by this audit.\n`);
if (process.env.P0_RECORD === '1') {
  await copyFile(logPath, join(here, 'verification.tap'));
  await copyFile(auditPath, join(here, 'process-audit.txt'));
}
console.log(`\nEvidence: ${logPath}\nProcess audit: ${auditPath}\nP0_RECORD=${process.env.P0_RECORD === '1' ? '1 (repository evidence refreshed)' : '0 (temporary files only)'}`);
process.exitCode = exit.code ?? 1;
if (alive.length) { console.error(`Recorded processes still alive: ${alive.join(', ')}`); process.exitCode = 1; }
