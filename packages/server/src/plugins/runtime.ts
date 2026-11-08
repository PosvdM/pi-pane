import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { negotiateProtocol, type PaneHostContext, type PanePlugin } from "@pi-pane/plugin-api";
import { ensurePrivateDir } from "pi-hostkit";
import { duration, PaneError } from "../errors.js";

export interface PluginState {
  locator: string;
  source?: string;
  state: "active" | "failed" | "disabled";
  error?: string;
  paneProtocol?: number;
}

export interface PluginRuntimeOptions {
  home: string;
  plugins: string[];
  timeoutMs?: number;
  createContext(source: string, protocol: number, dataDir: string, isCurrent: () => boolean): PaneHostContext;
  onUnavailable(source: string): void;
  onActive(source: string): void;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

interface Entry {
  view: PluginState;
  current: boolean;
  plugin?: PanePlugin;
  cleanup?: Promise<void>;
  unavailable: boolean;
  cancel: Set<() => void>;
}

function validSource(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase() !== "pane"
    && /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export class PluginRuntime {
  private readonly entries: Entry[];
  private readonly owners = new Map<string, Entry>();
  private readonly sources = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly home: string;
  private readonly cwd = process.cwd();
  private readonly log: NonNullable<PluginRuntimeOptions["log"]>;
  private started?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: PluginRuntimeOptions) {
    this.home = resolve(options.home);
    this.timeoutMs = Math.min(duration(options.timeoutMs, 10_000), 60_000);
    this.log = options.log ?? console;
    this.entries = options.plugins.map(locator => ({
      view: { locator, state: "disabled" }, current: true, unavailable: false, cancel: new Set(),
    }));
  }

  start(): Promise<void> {
    return this.started ??= this.closed ? Promise.resolve() : this.startAll();
  }

  list(): PluginState[] {
    return this.entries.map(entry => ({ ...entry.view }));
  }

  get(source: string): PanePlugin {
    const entry = this.owners.get(this.key(source));
    if (!entry?.current || entry.view.state !== "active" || !entry.plugin) {
      throw new PaneError("pluginUnavailable", `插件 ${source} 不可用`, 503);
    }
    return entry.plugin;
  }

  // 这里只隔离只读调用；动作的幂等性、事务和迟到结果由动作模块处理。
  async call<T>(source: string, method: string, fn: (plugin: PanePlugin) => T | Promise<T>, timeoutMs?: number): Promise<T> {
    const plugin = this.get(source);
    const entry = this.owners.get(this.key(source))!;
    return this.run(entry, method, () => fn(plugin), Math.min(duration(timeoutMs, this.timeoutMs), 60_000));
  }

  async stop(source: string): Promise<void> {
    const entries = this.entries.filter(entry => entry.view.source !== undefined && this.key(entry.view.source) === this.key(source));
    for (const entry of entries) this.fence(entry, "disabled");
    await Promise.all(entries.map(entry => this.cleanup(entry)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let complete!: () => void;
    this.closing = new Promise<void>(resolveClose => { complete = resolveClose; });
    for (const entry of this.entries) this.fence(entry, "disabled");
    void Promise.all(this.entries.map(entry => this.cleanup(entry))).then(complete);
    return this.closing;
  }

  configured(source: string): boolean {
    // 未识别的配置项可能就是遗留横幅的来源，不能据此删除横幅。
    return this.entries.some(entry => {
      const known = this.sources.get(entry.view.locator);
      return known === undefined || this.key(known) === this.key(source);
    });
  }

  private key(source: string): string {
    return process.platform === "win32" ? source.toLowerCase() : source;
  }

  private report(level: "info" | "warn" | "error", ...args: unknown[]): void {
    try { this.log[level](...args); } catch { /* 日志故障不能打断插件隔离。 */ }
  }

  private notify(kind: "onActive" | "onUnavailable", source: string): void {
    try { this.options[kind](source); }
    catch (error) { this.report("error", `插件 ${source} 的宿主回调 ${kind} 失败`, error); }
  }

  private async startAll(): Promise<void> {
    try {
      const sources = await this.run(undefined, "读取插件来源", () => this.readSources());
      for (const [locator, source] of sources) this.sources.set(locator, source);
    } catch (error) {
      this.report("warn", "无法读取插件来源，保守保留未识别来源的横幅", error);
    }
    if (this.closed) return;
    for (const entry of this.entries) entry.view.source = this.sources.get(entry.view.locator);
    await Promise.all(this.entries.map(entry => this.load(entry)));
  }

  private async readSources(): Promise<Map<string, string>> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(join(this.home, "runtime-sources.json"), "utf8")); }
    catch (error) { if (missing(error)) return new Map(); throw error; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.values(parsed).some(source => !validSource(source))) {
      throw new Error("插件来源元数据无效");
    }
    return new Map(Object.entries(parsed) as [string, string][]);
  }

  private persistSources(): Promise<void> {
    const contents = JSON.stringify(Object.fromEntries(this.sources), null, 2) + "\n";
    this.writes = this.writes.then(async () => {
      const temporary = join(this.home, `.runtime-sources-${randomUUID()}.tmp`);
      try {
        await ensurePrivateDir(this.home);
        await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.home, "runtime-sources.json"));
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }).catch(error => { this.report("error", "保存插件来源失败", error); });
    return this.writes;
  }

  private async metadata(locator: string): Promise<{ directory: string; entry: string; protocol: number }> {
    let directory = resolve(this.cwd, locator);
    let contents: string;
    try { contents = await readFile(join(directory, "package.json"), "utf8"); }
    catch (error) {
      if (!missing(error) || isAbsolute(locator) || locator.startsWith(".")) throw error;
      if (!/^(?:@[^/\\]+\/)?[^/\\]+$/.test(locator)) throw new Error("插件定位符必须为目录或 npm 包名");
      const require = createRequire(join(this.cwd, "package.json"));
      let found: string | undefined;
      // 直接寻找包目录，兼容未在 exports 中公开 package.json 的 npm 包。
      for (const base of require.resolve.paths(locator) ?? []) {
        const candidate = join(base, locator);
        try { found = await readFile(join(candidate, "package.json"), "utf8"); directory = candidate; break; }
        catch (candidateError) { if (!missing(candidateError)) throw candidateError; }
      }
      if (found === undefined) throw new Error(`找不到插件 ${locator}`);
      contents = found;
    }
    const metadata = JSON.parse(contents)?.piPane;
    if (!metadata || typeof metadata.entry !== "string" || !metadata.entry) throw new Error("插件缺少 piPane.entry");
    const entry = resolve(directory, metadata.entry);
    const inside = relative(directory, entry);
    if (isAbsolute(metadata.entry) || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error("插件入口必须位于包目录内");
    }
    const protocol = negotiateProtocol(metadata.paneProtocol);
    return { directory, entry, protocol };
  }

  private async load(entry: Entry): Promise<void> {
    try {
      const metadata = await this.run(entry, "解析入口", () => this.metadata(entry.view.locator));
      const module = await this.run(entry, "导入入口", () => import(pathToFileURL(metadata.entry).href));
      const plugin = await this.run(entry, "createPlugin", () => {
        if (typeof module.default !== "function") throw new Error("插件必须默认导出同步 createPlugin 工厂");
        const instance: unknown = module.default();
        if (instance && typeof instance === "object" && "then" in instance && typeof instance.then === "function") {
          void Promise.resolve(instance).catch(error => this.report("error", "异步插件工厂失败", error));
          throw new Error("createPlugin 必须同步返回插件实例");
        }
        if (!instance || typeof instance !== "object") throw new Error("插件工厂未返回实例");
        const plugin = instance as PanePlugin;
        if (!validSource(plugin.id)) throw new Error("插件 id 无效或属于保留名称");
        entry.view.source = plugin.id;
        this.sources.set(entry.view.locator, plugin.id);
        if (this.owners.has(this.key(plugin.id))) throw new Error(`插件 id 重复：${plugin.id}`);
        this.owners.set(this.key(plugin.id), entry);
        // 在工厂返回的同一轮执行中登记实例，关闭时才能清理它。
        entry.plugin = plugin;
        return plugin;
      });
      // 元数据和实例同时约束版本，不能让实例扩大包声明的范围。
      entry.view.paneProtocol = negotiateProtocol(plugin.paneProtocol, [metadata.protocol, metadata.protocol]);
      if (typeof plugin.activate !== "function") throw new Error("插件缺少 activate 方法");
      await this.run(entry, "保存来源", () => this.persistSources());
      const dataDir = join(this.home, "plugins", plugin.id);
      await this.run(entry, "创建数据目录", () => ensurePrivateDir(dataDir));
      const context = await this.run(entry, "创建上下文", () => this.options.createContext(
        plugin.id, entry.view.paneProtocol!, dataDir, () => entry.current && !this.closed,
      ));
      await this.run(entry, "activate", () => plugin.activate(context));
      if (!entry.current || this.closed) return;
      entry.view.state = "active";
      this.notify("onActive", plugin.id);
      this.report("info", `插件 ${plugin.id} 已激活`);
    } catch (error) {
      if (entry.current) {
        this.fence(entry, "failed", message(error));
        this.report("error", `加载插件 ${entry.view.locator} 失败`, error);
      }
      await this.cleanup(entry);
    } finally {
      // 版本或初始化失败时仍需保存已识别的来源。
      if (!this.closed && entry.view.source && this.sources.get(entry.view.locator) === entry.view.source) {
        await this.run(undefined, "保存来源", () => this.persistSources()).catch(() => {});
      }
    }
  }

  private fence(entry: Entry, state: PluginState["state"], error?: string): void {
    entry.current = false;
    entry.view.state = state;
    if (error !== undefined) entry.view.error = error;
    for (const cancel of [...entry.cancel]) cancel();
    const source = entry.view.source;
    const owner = source === undefined ? undefined : this.owners.get(this.key(source));
    if (source && !entry.unavailable && (!owner || owner === entry)) {
      entry.unavailable = true;
      this.notify("onUnavailable", source);
    }
  }

  private cleanup(entry: Entry): Promise<void> {
    return entry.cleanup ??= entry.plugin
      ? this.run(undefined, `${entry.view.source}.deactivate`, () => entry.plugin!.deactivate?.()).then(() => {}, () => {})
      : Promise.resolve();
  }

  private run<T>(entry: Entry | undefined, method: string, fn: () => T | PromiseLike<T>, timeoutMs = this.timeoutMs): Promise<T> {
    return new Promise<T>((resolveResult, reject) => {
      let settled = false;
      const finish = (ok: boolean, value: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry?.cancel.delete(cancel);
        if (ok) resolveResult(value as T);
        else reject(value);
      };
      const cancel = (): void => finish(false, new PaneError("pluginUnavailable", `插件 ${entry?.view.source ?? entry?.view.locator} 不可用`, 503));
      const timer = setTimeout(() => {
        const error = new PaneError("pluginTimeout", `插件方法 ${method} 超时（${timeoutMs}ms）`, 504);
        this.report("warn", error.message);
        finish(false, error);
      }, timeoutMs);
      entry?.cancel.add(cancel);
      if (entry && !entry.current) { cancel(); return; }
      Promise.resolve().then(() => {
        if (entry && !entry.current) throw new PaneError("pluginUnavailable", "插件已停用", 503);
        return fn();
      }).then(value => finish(true, value), error => {
        this.report("error", `插件方法 ${method} 失败`, error);
        finish(false, error instanceof PaneError ? error : new PaneError("pluginFailed", `插件方法 ${method} 失败：${message(error)}`, 502));
      });
    });
  }
}
