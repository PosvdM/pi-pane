// 界面全局状态：提示消息、扩展 UI 请求、项目信任询问、确认对话框。
import { Store } from "./store.ts";
import type { PaneTrustRequest, PaneUiRequest } from "./types.ts";

export interface Toast { id: string; level: "info" | "warning" | "error"; text: string; sticky?: boolean }
export const toasts = new Store<Toast[]>([]);
export function toast(text: string, level: Toast["level"] = "info", sticky = level === "error"): void {
  const id = crypto.randomUUID();
  toasts.set((list) => [...list.slice(-4), { id, level, text, sticky }]);
  if (!sticky) setTimeout(() => dismissToast(id), level === "warning" ? 8000 : 5000);
}
export function dismissToast(id: string): void { toasts.set((list) => list.filter((t) => t.id !== id)); }

export type DialogRequest = Extract<PaneUiRequest, { kind: "select" | "confirm" | "input" | "editor" }>;
export interface ExtensionUi {
  dialogs: DialogRequest[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}
/** 按会话 id 保存的扩展 UI 状态。 */
export const extensionUi = new Store<Record<string, ExtensionUi>>({});
export const emptyUi = (): ExtensionUi => ({ dialogs: [], statuses: {}, widgets: {} });

export const trustRequests = new Store<PaneTrustRequest[]>([]);

/** 应用内确认对话框（冲突重新确认、关闭确认等）。 */
export interface ChoiceDialog {
  title: string;
  message: string;
  choices: { label: string; value: string; primary?: boolean; danger?: boolean }[];
  resolve: (value: string | null) => void;
}
export const choice = new Store<ChoiceDialog | null>(null);
export function ask(title: string, message: string, choices: ChoiceDialog["choices"]): Promise<string | null> {
  return new Promise((resolve) => {
    choice.get()?.resolve(null);
    choice.set({ title, message, choices, resolve: (value) => { choice.set(null); resolve(value); } });
  });
}

/** 设置面板、模型选择等弹层的开关。 */
export const overlay = new Store<null | "settings" | "models" | "thinking" | "session-info" | "fork" | "new-session">(null);
