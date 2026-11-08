// 最小的可订阅状态容器。组件用 useStore 读取，set 后通知全部订阅者重新渲染。
import { useEffect, useState } from "preact/hooks";

export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T { return this.value; }
  set(next: T | ((value: T) => T)): void {
    this.value = typeof next === "function" ? (next as (value: T) => T)(this.value) : next;
    for (const listener of [...this.listeners]) listener();
  }
  /** 原地修改后通知订阅者。用于频繁更新的大对象，调用方保证修改的对象不被组件缓存比较。 */
  touch(): void { for (const listener of [...this.listeners]) listener(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export function useStore<T>(store: Store<T>): T {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);
  return store.get();
}
