// 标签页标识（architecture.md“取回草稿的交付”）。输入框草稿按标签页分键保存，每个键只由一个标签页写入。
// 每个标签页有一个 tabId，保存在 sessionStorage 中，刷新后不变。
// 有 Web Locks 时，页面存活期间一直持有锁 pi-pane.tab.<tabId>，其他标签页据此判断它是否已关闭；
// 启动时这个锁被别的页面持有（浏览器“复制标签页”会复制 sessionStorage），就换一个新的 tabId。
// 没有 Web Locks 时（非安全上下文，例如经局域网 http 访问），改用 localStorage 中的存活记录，见 TabIdentity。
// 纯逻辑，存储和 Web Locks 由调用方传入，可在 Node.js 中测试。
import { Store } from "./store.ts";

type Locks = Pick<LockManager, "request">;
export interface TabEnv {
  session: Storage | null;
  local: Storage;
  /** 不可用时为 null。 */
  locks: Locks | null;
  now?: () => number;
  newId?: () => string;
}

export const TAB_KEY = "pi-pane.tab";
export const TAB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const tabLock = (tabId: string) => `pi-pane.tab.${tabId}`;
export const aliveKey = (tabId: string) => `pi-pane.alive.${tabId}`;
/** 刷新时旧页面可能还没释放锁：启动时最多等这么久，仍拿不到才认为另一个页面在用这个 tabId。 */
export const TAB_LOCK_WAIT_MS = 1_000;
/** 没有 Web Locks 时，存活记录的更新间隔。后台标签页的定时器可能被浏览器限制到每分钟一次。 */
export const ALIVE_BEAT_MS = 60_000;
/** 没有 Web Locks 时：存活记录在这段时间内更新过，启动时认为另一个页面正在使用这个 tabId（复制的标签页）。 */
export const ALIVE_FRESH_MS = 5 * 60_000;
/** 没有 Web Locks 时：存活记录超过这段时间没有更新，才认为该标签页已关闭（例如浏览器崩溃，没能删除记录）。 */
export const ALIVE_STALE_MS = 24 * 3_600_000;

interface Alive { instance: string; at: number }

function readAlive(local: Storage, tabId: string): Alive | null {
  try {
    const value = JSON.parse(local.getItem(aliveKey(tabId)) ?? "null");
    return value && typeof value.instance === "string" ? { instance: value.instance, at: Number(value.at) || 0 } : null;
  } catch { return null; }
}

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

/**
 * 一个页面的标签页标识。没有 Web Locks 时，页面在 localStorage 的 pi-pane.alive.<tabId> 中写入存活记录
 * （本页面的随机实例标识和更新时间），定期更新，页面隐藏（pagehide）时删除。
 * 写入草稿前先核对记录：记录已属于另一个实例（本页冻结期间启动的复制标签页接管了这个 tabId），本页就换一个新的 tabId。
 */
export class TabIdentity {
  id: string;
  readonly locks: boolean;
  private readonly instance: string;
  private readonly env: TabEnv;
  constructor(id: string, instance: string, env: TabEnv) { this.id = id; this.instance = instance; this.env = env; this.locks = env.locks !== null; }
  private now(): number { return (this.env.now ?? Date.now)(); }

  /** 本页的 tabId，写入草稿前调用。没有 Web Locks 时核对并更新存活记录，可能换成新的 tabId。 */
  own(): string {
    if (!this.locks) this.beat();
    return this.id;
  }
  /** 没有 Web Locks 时：更新存活记录；记录已属于另一个实例时换一个新的 tabId。 */
  beat(): void {
    const record = readAlive(this.env.local, this.id);
    if (record && record.instance !== this.instance) {
      this.id = newTabId(this.env);
      remember(this.env, this.id);
    }
    this.write();
  }
  /** 写入本页的存活记录。启动时直接写入：沿用的 tabId 上留着的旧记录属于已关闭或已丢弃的页面。 */
  write(): void {
    try { this.env.local.setItem(aliveKey(this.id), JSON.stringify({ instance: this.instance, at: this.now() })); } catch { /* 写满时下次更新重试。 */ }
  }
  /** 没有 Web Locks 时：页面隐藏（关闭、刷新或进入往返缓存）时删除本页的存活记录。 */
  hide(): void {
    if (this.locks || readAlive(this.env.local, this.id)?.instance !== this.instance) return;
    try { this.env.local.removeItem(aliveKey(this.id)); } catch { /* 忽略。 */ }
  }
  /** 没有 Web Locks 时判断另一个标签页是否可能仍打开：存活记录存在且在 ALIVE_STALE_MS 内更新过。 */
  alive(tabId: string): boolean {
    if (tabId === this.id) return true;
    const record = readAlive(this.env.local, tabId);
    return record !== null && this.now() - record.at <= ALIVE_STALE_MS;
  }
}

const newTabId = (env: TabEnv) => (env.newId ?? (() => crypto.randomUUID()))();
function remember(env: TabEnv, tabId: string): void {
  try { env.session?.setItem(TAB_KEY, tabId); } catch { /* sessionStorage 不可用时每次加载都是新的 tabId，原键由其他标签页收养。 */ }
}

/**
 * 确定本页的 tabId：沿用 sessionStorage 中的值，除非另一个页面正在使用它。
 * 有 Web Locks 时以能否取得 pi-pane.tab.<tabId> 判断（最多等待 TAB_LOCK_WAIT_MS），取得后一直持有；
 * 没有时，存活记录在 ALIVE_FRESH_MS 内更新过就换新的 tabId（刷新的页面在 pagehide 时已删除自己的记录）。
 */
export async function claimTab(env: TabEnv): Promise<TabIdentity> {
  let id: string | null = null;
  try { const saved = env.session?.getItem(TAB_KEY) ?? null; if (saved && TAB_ID.test(saved)) id = saved; } catch { /* 按没有处理。 */ }
  const instance = newTabId(env);
  if (env.locks) {
    if (!id || !await hold(env.locks, tabLock(id), TAB_LOCK_WAIT_MS)) {
      do id = newTabId(env); while (!await hold(env.locks, tabLock(id)));
    }
  } else {
    const record = id ? readAlive(env.local, id) : null;
    if (!id || (record && (env.now ?? Date.now)() - record.at < ALIVE_FRESH_MS)) id = newTabId(env);
  }
  remember(env, id);
  const tab = new TabIdentity(id, instance, env);
  if (!tab.locks) tab.write();
  return tab;
}

let current: TabIdentity | null = null;
/** 本页的标签页标识已确定。输入框在此之前不读写草稿。 */
export const tabReady = new Store(false);

/** 页面启动时调用一次：确定 tabId；没有 Web Locks 时定期更新存活记录，页面隐藏时删除、恢复显示时重新写入。 */
export async function installTab(): Promise<void> {
  const locks = (navigator as { locks?: Locks }).locks ?? null;
  let session: Storage | null = null;
  try { session = sessionStorage; } catch { /* 不可用。 */ }
  current = await claimTab({ session, local: localStorage, locks });
  if (!current.locks) {
    const tab = current;
    setInterval(() => tab.beat(), ALIVE_BEAT_MS);
    addEventListener("pagehide", () => tab.hide());
    addEventListener("pageshow", (event) => { if (event.persisted) tab.beat(); });
  }
  tabReady.set(true);
}

/** 本页的 tabId，写入草稿前调用（见 TabIdentity.own）。 */
export function ownTab(): string {
  if (!current) throw new Error("标签页标识尚未确定");
  return current.own();
}
/** 没有 Web Locks 时判断另一个标签页是否可能仍打开（见 TabIdentity.alive）。 */
export function tabAlive(tabId: string): boolean { return current?.alive(tabId) ?? true; }
