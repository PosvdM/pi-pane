// 标签页标识（architecture.md“取回草稿的交付”）。输入框草稿按标签页分键保存，每个键只由一个标签页写入。
// 每个标签页有一个 tabId，保存在 sessionStorage 中，刷新后不变。页面存活期间一直持有 Web Lock pi-pane.tab.<tabId>，
// 其他标签页据此判断它是否已关闭；启动时这个锁被别的页面持有（浏览器“复制标签页”会复制 sessionStorage），就换一个新的 tabId。
// pi-pane 只在安全上下文中运行（规范源 http://127.0.0.1:<port>），Chrome 在安全上下文中总有 Web Locks。
// 没有 Web Locks 时无法判断 tabId 是否被另一个页面使用，每次加载都换新的 tabId，之前的键留给有 Web Locks 的页面收养。
// 纯逻辑，存储和 Web Locks 由调用方传入，可在 Node.js 中测试。
import { Store } from "./store.ts";

type Locks = Pick<LockManager, "request">;
export interface TabEnv {
  session: Storage | null;
  /** 不可用时为 null。 */
  locks: Locks | null;
  newId?: () => string;
}

export const TAB_KEY = "pi-pane.tab";
export const TAB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const tabLock = (tabId: string) => `pi-pane.tab.${tabId}`;
/** 刷新时旧页面可能还没释放锁：启动时最多等这么久，仍拿不到才认为另一个页面在用这个 tabId。 */
export const TAB_LOCK_WAIT_MS = 1_000;

/** 持有锁直到页面关闭。wait 为 undefined 时只在锁空闲时取得；否则最多等待 wait 毫秒。返回是否取得。 */
function hold(locks: Locks, name: string, wait?: number): Promise<boolean> {
  return new Promise((resolve) => {
    const options: LockOptions = wait === undefined ? { ifAvailable: true } : { signal: AbortSignal.timeout(wait) };
    locks.request(name, options, (lock) => {
      resolve(lock !== null);
      return lock ? new Promise<void>(() => {}) : undefined;
    }).catch(() => resolve(false));
  });
}

const newTabId = (env: TabEnv) => (env.newId ?? (() => crypto.randomUUID()))();

/**
 * 确定本页的 tabId：有 Web Locks 时沿用 sessionStorage 中的值，除非另一个页面正在使用它（最多等待 TAB_LOCK_WAIT_MS 仍取不到 pi-pane.tab.<tabId>），
 * 取得后一直持有。没有 Web Locks 时总是换新的 tabId。
 */
export async function claimTab(env: TabEnv): Promise<string> {
  let id: string | null = null;
  if (env.locks) {
    try { const saved = env.session?.getItem(TAB_KEY) ?? null; if (saved && TAB_ID.test(saved)) id = saved; } catch { /* 按没有处理。 */ }
    if (!id || !await hold(env.locks, tabLock(id), TAB_LOCK_WAIT_MS)) {
      do id = newTabId(env); while (!await hold(env.locks, tabLock(id)));
    }
  } else id = newTabId(env);
  try { env.session?.setItem(TAB_KEY, id); } catch { /* sessionStorage 不可用时每次加载都是新的 tabId，原键由其他标签页收养。 */ }
  return id;
}

let current: string | null = null;
/** 本页的标签页标识已确定。输入框在此之前不读写草稿。 */
export const tabReady = new Store(false);

/** 页面启动时调用一次：确定 tabId。ready 在主界面显示之前调用，用来恢复按 tabId 保存的状态。 */
export async function installTab(ready?: (tabId: string) => void): Promise<void> {
  let session: Storage | null = null;
  try { session = sessionStorage; } catch { /* 不可用。 */ }
  current = await claimTab({ session, locks: (navigator as { locks?: Locks }).locks ?? null });
  try { ready?.(current); } finally { tabReady.set(true); }
}

/** 本页的 tabId。 */
export function ownTab(): string {
  if (!current) throw new Error("标签页标识尚未确定");
  return current;
}
