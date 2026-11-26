// 最小的可订阅状态容器。组件用 useStore 读取，set 后通知全部订阅者重新渲染。
import { useEffect, useRef, useState } from "preact/hooks";

export class Store<T> {
  private listeners = new Set<() => void>();
  private value: T;
  /** 每次 set 或 touch 加一，useStore 据此发现渲染与订阅之间漏掉的更新。 */
  version = 0;
  // 不用参数属性：Node.js 的类型剥离不支持，纯逻辑测试需要直接导入本文件。
  constructor(value: T) { this.value = value; }
  get(): T { return this.value; }
  set(next: T | ((value: T) => T)): void {
    this.value = typeof next === "function" ? (next as (value: T) => T)(this.value) : next;
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
  /** 原地修改后通知订阅者。用于频繁更新的大对象，调用方保证修改的对象不被组件缓存比较。 */
  touch(): void { this.version++; for (const listener of [...this.listeners]) listener(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/**
 * 订阅在渲染之后的 effect 里建立；其间发生的更新（如页面加载时插件目录恰好在首次渲染后到达）
 * 不会通知到组件，所以订阅时比较渲染时记下的版本，变了就重新渲染。
 */
export function useStore<T>(store: Store<T>): T {
  const [, setTick] = useState(0);
  const rendered = useRef(store.version);
  rendered.current = store.version;
  useEffect(() => {
    const off = store.subscribe(() => setTick((n) => n + 1));
    if (store.version !== rendered.current) setTick((n) => n + 1);
    return off;
  }, [store]);
  return store.get();
}
