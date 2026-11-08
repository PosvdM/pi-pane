// 本浏览器的界面偏好，保存在 localStorage。
import { Store } from "./store.ts";

const KEY = "pi-pane.settings";
export interface Settings { showHidden: boolean }
function load(): Settings {
  try { return { showHidden: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { showHidden: false }; }
}
export const settings = new Store<Settings>(load());
export function updateSettings(change: Partial<Settings>): void {
  settings.set((s) => ({ ...s, ...change }));
  localStorage.setItem(KEY, JSON.stringify(settings.get()));
}
