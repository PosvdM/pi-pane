// 标签页标识（packages/web/src/lib/tab.ts）：tabId 的分配、复制标签页时换新、刷新时沿用，以及没有 Web Locks 时的存活记录。
// 用替身 Web Locks 和 Storage 模拟同一浏览器中的多个页面，不启动浏览器。
import test from "node:test";
import assert from "node:assert/strict";
import { ALIVE_FRESH_MS, ALIVE_STALE_MS, TAB_ID, TAB_KEY, aliveKey, claimTab, tabLock } from "../packages/web/src/lib/tab.ts";

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
  const browser = browserLocks(); const local = new MemoryStorage();
  const first = { session: new MemoryStorage(), locks: browser.page() };
  const a = await claimTab({ session: first.session, local, locks: first.locks, newId });
  assert.match(a.id, TAB_ID);
  assert.equal(first.session.getItem(TAB_KEY), a.id);
  assert.equal(browser.holders.get(tabLock(a.id)), first.locks.mine, "页面存活期间一直持有锁");

  // 复制标签页：sessionStorage 被复制，原页仍持有锁，等待期满后换新 tabId。
  const copy = { session: new MemoryStorage(), locks: browser.page() };
  copy.session.setItem(TAB_KEY, a.id);
  const started = Date.now();
  const b = await claimTab({ session: copy.session, local, locks: copy.locks, newId });
  assert.notEqual(b.id, a.id);
  assert.equal(copy.session.getItem(TAB_KEY), b.id);
  assert.ok(Date.now() - started >= 900, "先等待原页释放锁");
  assert.equal(browser.holders.get(tabLock(a.id)), first.locks.mine, "原页的锁不受影响");

  // 刷新：旧页面关闭后释放锁，新页面沿用同一个 tabId。旧页面稍晚才释放时同样沿用。
  const reload = { session: first.session, locks: browser.page() };
  setTimeout(() => first.locks.close(), 100);
  const again = await claimTab({ session: reload.session, local, locks: reload.locks, newId });
  assert.equal(again.id, a.id);
  assert.equal(browser.holders.get(tabLock(a.id)), reload.locks.mine);

  // sessionStorage 中的值不像 tabId 时按没有处理。
  const odd = new MemoryStorage(); odd.setItem(TAB_KEY, "../x");
  assert.match((await claimTab({ session: odd, local, locks: browser.page(), newId })).id, TAB_ID);
  // sessionStorage 不可用时每次都是新的 tabId。
  assert.match((await claimTab({ session: null, local, locks: browser.page(), newId })).id, TAB_ID);
});

test("没有 Web Locks：存活记录在页面隐藏时删除，刷新沿用 tabId；复制标签页看到新近更新的记录时换新 tabId", async () => {
  const local = new MemoryStorage(); let now = 1_000_000;
  const env = (session) => ({ session, local, locks: null, now: () => now, newId });
  const session = new MemoryStorage();
  const a = await claimTab(env(session));
  assert.equal(a.locks, false);
  assert.notEqual(local.getItem(aliveKey(a.id)), null, "启动时写入存活记录");

  // 复制标签页：原页的记录刚更新过。
  const copied = new MemoryStorage(); copied.setItem(TAB_KEY, a.id);
  now += ALIVE_FRESH_MS - 1;
  const b = await claimTab(env(copied));
  assert.notEqual(b.id, a.id);
  assert.equal(a.own(), a.id, "原页的记录仍属于自己，不换 tabId");

  // 刷新：pagehide 删除记录，重新加载时沿用。
  a.hide();
  assert.equal(local.getItem(aliveKey(a.id)), null);
  const reloaded = await claimTab(env(session));
  assert.equal(reloaded.id, a.id);

  // 记录很久没有更新（页面被浏览器丢弃后重新加载，或崩溃后恢复）：沿用。
  const discarded = await claimTab(env(new MemoryStorage()));
  const restored = new MemoryStorage(); restored.setItem(TAB_KEY, discarded.id);
  now += ALIVE_FRESH_MS + 1;
  assert.equal((await claimTab(env(restored))).id, discarded.id);
});

test("没有 Web Locks：本页冻结期间复制的标签页接管了 tabId 时，本页写入前发现记录已属于另一个实例，换新 tabId，两页不写同一个键", async () => {
  const local = new MemoryStorage(); let now = 1_000_000;
  const env = (session) => ({ session, local, locks: null, now: () => now, newId });
  const session = new MemoryStorage();
  const frozen = await claimTab(env(session));
  const old = frozen.id;
  now += ALIVE_FRESH_MS + 1; // 冻结期间没有更新记录。
  const copied = new MemoryStorage(); copied.setItem(TAB_KEY, old);
  const copy = await claimTab(env(copied));
  assert.equal(copy.id, old, "记录已过期，复制的标签页沿用");
  // 冻结的页面恢复后第一次写入或更新存活记录。
  const mine = frozen.own();
  assert.notEqual(mine, old);
  assert.equal(session.getItem(TAB_KEY), mine);
  assert.equal(copy.own(), old, "接管者不受影响");
  frozen.beat();
  assert.equal(frozen.id, mine, "之后照常更新自己的记录");
});

test("没有 Web Locks：存活记录不存在或超过 ALIVE_STALE_MS 未更新时，其他页面才判断该标签页已关闭", async () => {
  const local = new MemoryStorage(); let now = 1_000_000;
  const env = () => ({ session: new MemoryStorage(), local, locks: null, now: () => now, newId });
  const a = await claimTab(env()); const b = await claimTab(env());
  assert.equal(a.alive(b.id), true);
  assert.equal(a.alive(a.id), true);
  now += ALIVE_STALE_MS;
  assert.equal(a.alive(b.id), true, "后台标签页的定时器可能被限制，期限内仍算存活");
  now += 1;
  assert.equal(a.alive(b.id), false);
  b.beat();
  assert.equal(a.alive(b.id), true);
  b.hide();
  assert.equal(a.alive(b.id), false, "页面关闭时删除记录，立即可以收养");
  assert.equal(a.alive("00000000-0000-4000-8000-999999999999"), false);
});
