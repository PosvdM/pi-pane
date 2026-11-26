// 插件列表与静态目录（动作、面板、自定义消息渲染器）。浏览器只认 pane 协议的声明式数据，不加载插件脚本。
import { api } from "./api.ts";
import { Store } from "./store.ts";
import type { ActionSpec, CustomMessageRenderer, PanePluginState, PanelSpec } from "./types.ts";

export interface Catalog { actions: ActionSpec[]; panels: PanelSpec[]; renderers: CustomMessageRenderer[] }
export interface PluginsState { list: PanePluginState[]; catalogs: Record<string, Catalog>; loaded: boolean }
export const plugins = new Store<PluginsState>({ list: [], catalogs: {}, loaded: false });

let seq = 0;
/** 读取插件列表和每个活动插件的目录；只有最后一次发起的读取可以提交。 */
export async function refreshPlugins(): Promise<void> {
  const mine = ++seq;
  try {
    const { plugins: list } = await api<{ plugins: PanePluginState[] }>("/api/plugins");
    const catalogs: Record<string, Catalog> = {};
    await Promise.all(list.filter((p) => p.state === "active" && p.source).map(async (p) => {
      try { catalogs[p.source!] = await api<Catalog>(`/api/plugins/${encodeURIComponent(p.source!)}/catalog`); }
      catch { catalogs[p.source!] = { actions: [], panels: [], renderers: [] }; }
    }));
    if (mine === seq) plugins.set({ list, catalogs, loaded: true });
  } catch { if (mine === seq) plugins.set((s) => ({ ...s, loaded: true })); }
}

export function activeSources(): string[] {
  return plugins.get().list.filter((p) => p.state === "active" && p.source).map((p) => p.source!);
}

/** 界面显示的插件名称：插件声明的 displayName，没有时为来源 id。 */
export function pluginName(source: string): string {
  return plugins.get().list.find((p) => p.source === source)?.displayName ?? source;
}

export function actionSpec(source: string, actionId: string): ActionSpec | undefined {
  return plugins.get().catalogs[source]?.actions.find((a) => a.id === actionId);
}

/** 按 customType 找渲染器；多个插件声明同一类型时服务端只保留先加载的。 */
export function rendererFor(customType: string): CustomMessageRenderer | undefined {
  for (const catalog of Object.values(plugins.get().catalogs)) {
    const found = catalog.renderers.find((r) => r.customType === customType);
    if (found) return found;
  }
  return undefined;
}
