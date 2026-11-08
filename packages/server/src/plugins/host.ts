import type {
  ActionSpec, CustomMessageRenderer, HistoryPage, MainSessionsApi, PaneHostContext, PanePlugin,
  PanelSpec, SessionRef, SessionSnapshot, SessionStreamEvent, StreamCursor, TreeChange,
  TreeChildrenPage, TreeCursor, TreeNode, TreeSnapshot, TreeSnapshotRequest,
} from "@pi-pane/plugin-api";
import { AssetStore } from "../assets.js";
import { assert, PaneError } from "../errors.js";
import { BannerStore } from "./banners.js";
import { PluginOperations } from "./operations.js";
import { PresenceBroker } from "./presence.js";
import { PluginRuntime } from "./runtime.js";

export interface PluginHostOptions {
  home: string;
  plugins: string[];
  mainSessions(source: string): MainSessionsApi;
  assets: AssetStore;
  emit(message: unknown): void;
  timeoutMs?: number;
}
interface PluginResources { releases: Set<() => void>; notifications: Set<string> }

/** 宿主仅提供通用能力；插件的后台协议与业务状态由插件自行处理。 */
export class PluginHost {
  readonly runtime: PluginRuntime;
  readonly banners: BannerStore;
  readonly presence = new PresenceBroker();
  readonly operations: PluginOperations;
  private readonly resources = new Map<string, PluginResources>();
  private readonly subscriptions = new Map<string, Set<() => void>>();
  private readonly rendererOwners = new Map<string, string>();
  private closing = false;
  constructor(private readonly options: PluginHostOptions) {
    this.banners = new BannerStore(options.home, options.emit, (source) => this.runtime.configured(source));
    this.runtime = new PluginRuntime({
      home: options.home, plugins: options.plugins, timeoutMs: options.timeoutMs,
      createContext: (source, protocol, dataDir, current) => this.context(source, protocol, dataDir, current),
      onUnavailable: (source) => this.unavailable(source),
      onActive: (source) => this.banners.availability(source, true),
    });
    this.operations = new PluginOperations({
      get: (source) => this.runtime.get(source),
      call: (source, name, fn, timeoutMs) => this.runtime.call(source, name, fn, timeoutMs),
      emit: options.emit, timeoutMs: options.timeoutMs,
    });
  }
  async start(): Promise<void> {
    this.banners.load();
    await this.runtime.start();
    for (const state of this.runtime.list()) if (state.state === "active" && state.source) {
      try { await this.catalog(state.source); } catch (error) { console.error(`插件 ${state.source} 的目录读取失败：`, error); }
      try { await this.operations.align(state.source); }
      catch (error) { console.error(`插件 ${state.source} 的持久表单对齐失败：`, error); }
    }
  }
  private context(source: string, paneProtocol: number, dataDir: string, current: () => boolean): PaneHostContext {
    const resource: PluginResources = { releases: new Set(), notifications: new Set() };
    this.resources.set(source, resource);
    const guard = () => { assert(!this.closing && current(), "pluginUnavailable", "插件上下文已失效", 409); };
    const tracked = (off: () => void) => {
      let active = true;
      const release = () => { if (!active) return; active = false; resource.releases.delete(release); off(); };
      resource.releases.add(release); return release;
    };
    const main = this.options.mainSessions(source);
    const presence = this.presence.api(source);
    return {
      paneProtocol, dataDir,
      log: {
        info: (...args) => console.info(`[插件 ${source}]`, ...args),
        warn: (...args) => console.warn(`[插件 ${source}]`, ...args),
        error: (...args) => console.error(`[插件 ${source}]`, ...args),
      },
      notify: (notification) => {
        guard(); assert(notification.source === source && typeof notification.id === "string" && typeof notification.title === "string" && ["info", "warning", "error"].includes(notification.level), "invalidNotification", "插件通知无效");
        if (resource.notifications.has(notification.id)) return;
        assert(resource.notifications.size < 10000, "notificationLimit", "插件通知去重记录达到上限", 429);
        resource.notifications.add(notification.id); this.options.emit({ type: "notification", notification: structuredClone(notification) });
      },
      panelChanged: (update) => { guard(); this.options.emit({ type: "panel", update: structuredClone(update) }); },
      formAdded: (form) => { guard(); this.operations.formAdded(source, form); },
      formRemoved: (id, reason) => { guard(); this.operations.formRemoved(source, id, reason); },
      setBanner: (banner) => { guard(); this.banners.set(source, banner); },
      clearBanner: (id) => { guard(); this.banners.clear(source, id); },
      listBanners: () => { guard(); return this.banners.own(source); },
      mainSessions: {
        list: () => { guard(); return main.list(); },
        get: (id) => { guard(); return main.get(id); },
        onChange: (listener) => { guard(); return tracked(main.onChange(() => { if (current() && !this.closing) { try { listener(); } catch (error) { console.error(`插件 ${source} 的会话监听失败：`, error); } } })); },
        hold: (ref, reason) => { guard(); assert(ref?.source === "pane" && typeof ref.id === "string" && typeof reason === "string" && reason.length > 0 && reason.length <= 1000, "invalidHold", "保活请求无效"); return tracked(main.hold(ref, reason)); },
      },
      userPresence: {
        devices: () => { guard(); return presence.devices(); },
        onDevicesChange: (listener) => { guard(); return tracked(presence.onDevicesChange(listener)); },
        confirm: (request) => { guard(); return presence.confirm(request); },
      },
    };
  }
  private unavailable(source: string): void {
    this.presence.cancelSource(source);
    this.operations.unavailable(source);
    this.banners.availability(source, false);
    for (const release of this.resources.get(source)?.releases ?? []) { try { release(); } catch (error) { console.error(`插件 ${source} 的资源清理失败：`, error); } }
    this.resources.delete(source);
    for (const [type, owner] of this.rendererOwners) if (owner === source) this.rendererOwners.delete(type);
    for (const off of this.subscriptions.get(source) ?? []) off();
    this.subscriptions.delete(source);
  }
  private tracked(source: string, subscribe: () => () => void): () => void {
    const records = this.subscriptions.get(source) ?? new Set<() => void>(); this.subscriptions.set(source, records);
    let active = true; let cancel: (() => void) | undefined;
    const off = () => { if (!active) return; active = false; records.delete(off); try { cancel?.(); } catch (error) { console.error(`插件 ${source} 的订阅清理失败：`, error); } };
    records.add(off);
    try { cancel = subscribe(); assert(typeof cancel === "function", "invalidPluginResult", "插件订阅没有返回取消函数", 502); }
    catch (error) { off(); throw error; }
    if (!active) { try { cancel(); } catch { /* 订阅同步回调可能在初始化结束前取消。 */ } }
    return off;
  }
  async catalog(source: string): Promise<{ actions: ActionSpec[]; panels: PanelSpec[]; renderers: CustomMessageRenderer[] }> {
    return this.runtime.call(source, "catalog", (plugin) => {
      const actions = plugin.actions?.list() ?? []; const panels = plugin.panels?.list() ?? [];
      assert(Array.isArray(actions) && Array.isArray(panels), "invalidPluginResult", "插件目录无效", 502);
      for (const item of [...actions, ...panels]) assert(item.source === source && typeof item.id === "string", "invalidPluginResult", "插件目录来源无效", 502);
      const renderers = (plugin.renderers?.customMessages ?? []).filter((renderer) => {
        const owner = this.rendererOwners.get(renderer.customType);
        if (owner && owner !== source) { console.warn(`自定义消息 ${renderer.customType} 已由插件 ${owner} 提供，忽略 ${source} 的声明`); return false; }
        this.rendererOwners.set(renderer.customType, source); return true;
      });
      return structuredClone({ actions, panels, renderers });
    });
  }
  async panel(source: string, panelId: string, nodeId?: string) {
    const { panels } = await this.catalog(source);
    assert(panels.some((panel) => panel.id === panelId), "panelMissing", "面板不存在", 404);
    return this.runtime.call(source, "panels.content", (plugin) => plugin.panels!.content(panelId, nodeId));
  }
  private nodes(source: string, nodes: TreeNode[], plugin: PanePlugin): TreeNode[] {
    assert(Array.isArray(nodes), "invalidPluginResult", "插件树节点无效", 502);
    const result = structuredClone(nodes); const index = new Map(result.map((node) => [node.id, node]));
    assert(index.size === result.length, "invalidPluginResult", "插件树节点标识重复", 502);
    const cycles = new Set<string>();
    for (const node of result) {
      const chain: string[] = []; const visited = new Map<string, number>(); let cursor: TreeNode | undefined = node;
      while (cursor) {
        const at = visited.get(cursor.id);
        if (at !== undefined) { for (const id of chain.slice(at)) cycles.add(id); break; }
        visited.set(cursor.id, chain.length); chain.push(cursor.id); cursor = cursor.parentId === null ? undefined : index.get(cursor.parentId);
      }
    }
    for (const node of result) {
      assert(node.source === source && typeof node.id === "string" && node.id.startsWith(source + ":") && Array.isArray(node.capabilities), "invalidPluginResult", "插件树节点来源无效", 502);
      if (node.sessionRef) assert(node.sessionRef.source === source, "invalidPluginResult", "插件会话来源无效", 502);
      const capabilities = node.capabilities.filter((capability) => {
        if (capability.startsWith("action:")) return typeof plugin.actions?.invoke === "function";
        if (node.kind !== "session") return false;
        if (capability === "open") return !!plugin.sessions?.snapshot && !!plugin.sessions?.history;
        if (capability === "subscribe") return !!plugin.sessions?.subscribe;
        if (capability === "send") return !!plugin.sessions?.send || !!node.composer && typeof plugin.actions?.invoke === "function";
        if (capability === "abort") return !!plugin.sessions?.abort;
        return false;
      });
      if (capabilities.length !== node.capabilities.length) console.warn(`插件 ${source} 声明了不可用的节点能力：${node.id}`);
      node.capabilities = capabilities;
      if (cycles.has(node.id)) { node.parentId = "pane:group:unassigned"; console.warn(`插件 ${source} 的树节点存在循环：${node.id}`); }
    }
    return result;
  }
  async treeSnapshot(source: string, request: TreeSnapshotRequest): Promise<TreeSnapshot> {
    assert(Array.isArray(request.openNodeIds) && request.openNodeIds.length <= 1000 && request.openNodeIds.every((id) => typeof id === "string") && typeof request.recentSince === "string" && Number.isFinite(Date.parse(request.recentSince)), "invalidTreeRequest", "树快照请求无效");
    return this.runtime.call(source, "tree.snapshot", async (plugin) => {
      assert(plugin.tree, "unsupportedCapability", "插件不提供会话树", 404);
      const value = await plugin.tree.snapshot(request);
      assert(value.source === source && typeof value.epoch === "string" && Number.isSafeInteger(value.revision) && value.revision >= 0, "invalidPluginResult", "插件树快照无效", 502);
      return { ...value, nodes: this.nodes(source, value.nodes, plugin) };
    });
  }
  async treeChildren(source: string, parentId: string, page: { epoch: string; cursor?: string; limit: number }): Promise<TreeChildrenPage> {
    assert(typeof parentId === "string" && typeof page.epoch === "string" && Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= 200, "invalidTreeRequest", "树分页请求无效");
    return this.runtime.call(source, "tree.children", async (plugin) => {
      assert(plugin.tree, "unsupportedCapability", "插件不提供会话树", 404);
      const value = await plugin.tree.children(parentId, page);
      if ("reset" in value || value.epoch !== page.epoch) return { reset: true, epoch: value.epoch };
      return { ...value, nodes: this.nodes(source, value.nodes, plugin) };
    });
  }
  treeSubscribe(source: string, after: TreeCursor, emit: (change: TreeChange) => void): () => void {
    const plugin = this.runtime.get(source); assert(plugin.tree, "unsupportedCapability", "插件不提供会话树", 404);
    assert(typeof after?.epoch === "string" && Number.isSafeInteger(after.revision) && after.revision >= 0, "invalidCursor", "树游标无效");
    return this.tracked(source, () => plugin.tree!.subscribe(after, (change) => {
      try {
        const value = change.type === "upsert" ? { ...change, node: this.nodes(source, [change.node], plugin)[0] } : structuredClone(change);
        emit(value);
      } catch (error) { console.error(`插件 ${source} 的树事件失败：`, error); emit({ type: "reset", epoch: after.epoch }); }
    }));
  }
  async snapshot(ref: SessionRef): Promise<SessionSnapshot> {
    return this.runtime.call(ref.source, "sessions.snapshot", async (plugin) => {
      assert(plugin.sessions, "unsupportedCapability", "插件不提供会话视图", 404);
      const value = await plugin.sessions.snapshot(ref);
      assert(value.ref?.source === ref.source && value.ref.id === ref.id, "invalidPluginResult", "插件会话快照来源无效", 502);
      return this.options.assets.detach(value);
    });
  }
  async history(ref: SessionRef, before: string, limit: number): Promise<HistoryPage> {
    assert(typeof before === "string" && Number.isSafeInteger(limit) && limit > 0 && limit <= 200, "invalidHistoryRequest", "历史分页请求无效");
    return this.runtime.call(ref.source, "sessions.history", async (plugin) => {
      assert(plugin.sessions, "unsupportedCapability", "插件不提供会话视图", 404);
      return this.options.assets.detach(await plugin.sessions.history(ref, { before, limit }));
    });
  }
  subscribe(ref: SessionRef, after: StreamCursor, emit: (event: SessionStreamEvent) => void): () => void {
    const plugin = this.runtime.get(ref.source); assert(plugin.sessions, "unsupportedCapability", "插件不提供会话视图", 404);
    assert(typeof after?.epoch === "string" && Number.isSafeInteger(after.seq) && after.seq >= 0, "invalidCursor", "会话游标无效");
    return this.tracked(ref.source, () => plugin.sessions!.subscribe(ref, after, (event) => {
      try {
        assert(event.ref?.source === ref.source && event.ref.id === ref.id, "invalidPluginResult", "插件会话事件来源无效", 502);
        emit(this.options.assets.detach(event));
      } catch (error) { console.error(`插件 ${ref.source} 的会话事件失败：`, error); emit({ ref, cursor: after, event: { type: "resync" } }); }
    }));
  }
  async close(): Promise<void> {
    if (this.closing) return; this.closing = true;
    this.presence.close(); this.operations.close();
    await this.runtime.close(); this.banners.close();
  }
}
