import { TARGETS, TARGET_NOTES, probe, launch, Skip } from '../lib/browsers.mjs';
import { note } from './helpers.mjs';

/** 默认只跑 Chrome；加上 WebKit 参考：P0_BROWSERS=chrome,webkit npm test */
export const SELECTED = (process.env.P0_BROWSERS ?? 'chrome')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => TARGETS.includes(s));

/**
 * 对每个选中的浏览器跑一个子测试。浏览器不可用时 skip 并写明原因。
 * fn(t, open, name) 中 open(mode, opts) 启动浏览器；测试结束后自动关闭。
 */
export async function forEachBrowser(t, fn, { timeoutMs = 180_000 } = {}) {
  for (const name of SELECTED) {
    await t.test(name, { timeout: timeoutMs }, async (st) => {
      const p = await probe(name);
      if (!p.ok) return st.skip(p.reason);
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
