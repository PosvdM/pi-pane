import { TARGETS, TARGET_NOTES, probe, launch, Skip } from '../lib/browsers.mjs';
import { note } from './helpers.mjs';

/** 只跑部分浏览器：P0_BROWSERS=chrome,firefox node --test ... */
export const SELECTED = (process.env.P0_BROWSERS ?? TARGETS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 对每个目标浏览器跑一个子测试。不可用或需要主人手动时 skip 并写明原因。
 * fn(t, open) 中 open(mode, opts) 启动浏览器；测试结束后自动关闭。
 */
export async function forEachBrowser(t, fn, { timeoutMs = 180_000 } = {}) {
  for (const name of TARGETS) {
    await t.test(name, { timeout: timeoutMs }, async (st) => {
      if (!SELECTED.includes(name)) return st.skip('未选择（P0_BROWSERS）');
      const p = await probe(name);
      if (!p.ok) return st.skip(`未测：${p.reason}`);
      note(st, 'browser', TARGET_NOTES[name]);
      const opened = [];
      const open = async (mode = 'normal', opts = {}) => {
        const b = await launch(name, { mode, ...opts });
        opened.push(b);
        return b;
      };
      try {
        await fn(st, open, name);
      } catch (e) {
        if (e instanceof Skip) return st.skip(e.message);
        throw e;
      } finally {
        for (const b of opened.reverse()) await b.close().catch(() => {});
      }
    });
  }
}
