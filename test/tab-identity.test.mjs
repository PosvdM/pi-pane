// 标签页标识（packages/web/src/lib/tab.ts）：tabId 的分配、复制标签页时换新、刷新时沿用，以及没有 Web Locks 时每次换新。
// 用替身 Web Locks 和 Storage 模拟同一浏览器中的多个页面，不启动浏览器。
import test from "node:test";
import assert from "node:assert/strict";
import { TAB_ID, TAB_KEY, claimTab, tabLock } from "../packages/web/src/lib/tab.ts";

class MemoryStorage {
  items = new Map();
  get length() { return this.items.size; }
  key(i) { return [...this.items.keys()][i] ?? null; }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) { this.items.set(key, String(value)); }
  removeItem(key) { this.items.delete(key); }
}

/** 同一浏览器配置共享的锁管理器。page() 返回一个页面使用的 navigator.locks，close() 模拟页面关闭、释放它持有的锁。 */
function browserLocks() {
  const holders = new Map(); const waiters = new Map();
  const release = (name) => {
    holders.delete(name);
    const queue = waiters.get(name); const next = queue?.shift();
    if (next) next();
  };
  return {
    holders,
    page() {
      const mine = new Set();
      return {
        mine,
        async request(name, options, callback) {
          if (typeof options === "function") { callback = options; options = {}; }
          if (holders.has(name)) {
            if (options.ifAvailable) return callback(null);
            await new Promise((resolve, reject) => {
              const queue = waiters.get(name) ?? []; waiters.set(name, queue);
              const grant = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
              const abort = () => { queue.splice(queue.indexOf(grant), 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
              options.signal?.addEventListener("abort", abort, { once: true });
              queue.push(grant);
            });
          }
          holders.set(name, mine); mine.add(name);
          try { return await callback({ name }); } finally { if (holders.get(name) === mine) { mine.delete(name); release(name); } }
        },
        close() { for (const name of [...mine]) { mine.delete(name); release(name); } },
      };
    },
  };
}
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

test("有 Web Locks：新页面分配 tabId 并持有锁；刷新沿用；复制标签页（sessionStorage 相同而原页仍开着）换新 tabId", async () => {
  const browser = browserLocks();
  const first = { session: new MemoryStorage(), locks: browser.page() };
  const a = await claimTab({ session: first.session, locks: first.locks, newId });
  assert.match(a, TAB_ID);
  assert.equal(first.session.getItem(TAB_KEY), a);
  assert.equal(browser.holders.get(tabLock(a)), first.locks.mine, "页面存活期间一直持有锁");

  // 复制标签页：sessionStorage 被复制，原页仍持有锁，等待期满后换新 tabId。
  const copy = { session: new MemoryStorage(), locks: browser.page() };
  copy.session.setItem(TAB_KEY, a);
  const started = Date.now();
  const b = await claimTab({ session: copy.session, locks: copy.locks, newId });
  assert.notEqual(b, a);
  assert.equal(copy.session.getItem(TAB_KEY), b);
  assert.ok(Date.now() - started >= 900, "先等待原页释放锁");
  assert.equal(browser.holders.get(tabLock(a)), first.locks.mine, "原页的锁不受影响");

  // 刷新：旧页面关闭后释放锁，新页面沿用同一个 tabId。旧页面稍晚才释放时同样沿用。
  const reload = { session: first.session, locks: browser.page() };
  setTimeout(() => first.locks.close(), 100);
  const again = await claimTab({ session: reload.session, locks: reload.locks, newId });
  assert.equal(again, a);
  assert.equal(browser.holders.get(tabLock(a)), reload.locks.mine);

  // sessionStorage 中的值不像 tabId 时按没有处理。
  const odd = new MemoryStorage(); odd.setItem(TAB_KEY, "../x");
  assert.match((await claimTab({ session: odd, locks: browser.page(), newId })), TAB_ID);
  // sessionStorage 不可用时每次都是新的 tabId。
  assert.match((await claimTab({ session: null, locks: browser.page(), newId })), TAB_ID);
});


test("没有 Web Locks：无法判断 tabId 是否被另一个页面使用，每次加载都换新的 tabId，两页不会写同一个键", async () => {
  const session = new MemoryStorage();
  const a = await claimTab({ session, locks: null, newId });
  assert.match(a, TAB_ID);
  assert.equal(session.getItem(TAB_KEY), a);
  // 刷新或复制标签页：sessionStorage 中的 tabId 不沿用。
  const b = await claimTab({ session, locks: null, newId });
  assert.notEqual(b, a);
  assert.equal(session.getItem(TAB_KEY), b);
});
