import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BannerState, PaneBanner, RequestOrigin } from "@pi-pane/plugin-api";
import { assert, PaneError } from "../errors.js";

const priority = { error: 0, warning: 1, info: 2 } as const;

type SavedBanner = PaneBanner & { source: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown, field: string): asserts value is string {
  assert(typeof value === "string" && value.trim().length > 0, "invalidBanner", `横幅 ${field} 必须为非空字符串`);
}

function bannerValue(value: unknown): PaneBanner {
  assert(object(value), "invalidBanner", "横幅必须为对象");
  identifier(value.id, "id");
  identifier(value.title, "title");
  assert(value.level === "error" || value.level === "warning" || value.level === "info", "invalidBanner", "横幅 level 无效");
  assert(value.body === undefined || typeof value.body === "string", "invalidBanner", "横幅 body 必须为字符串");
  assert(value.persistent === undefined || typeof value.persistent === "boolean", "invalidBanner", "横幅 persistent 必须为布尔值");
  assert(value.actions === undefined || (Array.isArray(value.actions) && [...value.actions].every(action => typeof action === "string" && action.trim().length > 0)), "invalidBanner", "横幅 actions 必须为非空字符串数组");
  return {
    id: value.id,
    level: value.level,
    title: value.title,
    ...(value.body === undefined ? {} : { body: value.body }),
    ...(value.actions === undefined ? {} : { actions: [...value.actions as string[]] }),
    ...(value.persistent === undefined ? {} : { persistent: value.persistent }),
  };
}

function copy(state: BannerState): BannerState {
  return { ...state, ...(state.actions === undefined ? {} : { actions: [...state.actions] }) };
}

export class BannerStore {
  private states: BannerState[] = [];
  private unavailable = new Set<string>();
  private readonly file: string;
  private readonly audit: (record: unknown) => void;

  constructor(
    private readonly home: string,
    private readonly emit: (message: unknown) => void,
    private readonly configured: (source: string) => boolean,
    log?: (record: unknown) => void,
  ) {
    this.file = join(home, "banners.json");
    this.audit = log ?? (record => {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const fd = openSync(join(this.home, "plugin-audit.jsonl"), "a", 0o600);
      try {
        appendFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  }

  load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.states = [];
      this.unavailable = new Set();
      return;
    }
    const loaded: BannerState[] = [];
    try {
      const data: unknown = JSON.parse(text);
      assert(object(data) && data.version === 1 && Array.isArray(data.banners), "invalidBannerFile", "横幅持久文件格式无效");
      const seen = new Map<string, Set<string>>();
      for (const entry of data.banners) {
        assert(object(entry), "invalidBannerFile", "横幅持久文件包含无效记录");
        identifier(entry.source, "source");
        const banner = bannerValue(entry);
        if (banner.persistent !== true) continue;
        const ids = seen.get(entry.source) ?? new Set<string>();
        assert(!ids.has(banner.id), "invalidBannerFile", "横幅持久文件包含重复的 source/id");
        ids.add(banner.id);
        seen.set(entry.source, ids);
        loaded.push({ ...banner, source: entry.source, sourceUnavailable: true });
      }
    } catch (error) {
      throw new PaneError("invalidBannerFile", `无法加载横幅持久文件 ${this.file}：${error instanceof Error ? error.message : String(error)}`, 500);
    }
    this.states = loaded;
    this.unavailable = new Set(loaded.map(state => state.source));
  }

  set(source: string, banner: PaneBanner): void {
    identifier(source, "source");
    const state: BannerState = { ...bannerValue(banner), source, sourceUnavailable: this.unavailable.has(source) };
    const index = this.states.findIndex(current => current.source === source && current.id === state.id);
    const next = [...this.states];
    if (index === -1) next.push(state);
    else next[index] = state;
    if (state.persistent || (index !== -1 && this.states[index].persistent)) this.persist(next);
    this.states = next;
    this.emit({ type: "banner", banner: copy(state) });
  }

  clear(source: string, id: string): void {
    identifier(source, "source");
    identifier(id, "id");
    const state = this.states.find(current => current.source === source && current.id === id);
    if (!state) return;
    const next = this.states.filter(current => current !== state);
    if (state.persistent) this.persist(next);
    this.states = next;
    this.emit({ type: "bannerCleared", source, id });
  }

  own(source: string): PaneBanner[] {
    identifier(source, "source");
    return this.sorted().filter(state => state.source === source).map(state => bannerValue(state));
  }

  list(): BannerState[] {
    return this.sorted().map(copy);
  }

  availability(source: string, active: boolean): void {
    identifier(source, "source");
    assert(typeof active === "boolean", "invalidBanner", "横幅来源可用性必须为布尔值");
    if (active) this.unavailable.delete(source);
    else this.unavailable.add(source);
    const changed: BannerState[] = [];
    const removed: BannerState[] = [];
    this.states = this.states.flatMap(state => {
      if (state.source !== source) return [state];
      if (!active && !state.persistent) {
        removed.push(state);
        return [];
      }
      if (state.sourceUnavailable === !active) return [state];
      const updated = { ...state, sourceUnavailable: !active };
      changed.push(updated);
      return [updated];
    });
    for (const state of removed) this.emit({ type: "bannerCleared", source, id: state.id });
    for (const state of changed) this.emit({ type: "banner", banner: copy(state) });
  }

  removable(): BannerState[] {
    return this.list().filter(state => state.persistent === true && !this.configured(state.source));
  }

  removeOrphan(source: string, id: string, origin: RequestOrigin, confirmed: boolean): void {
    identifier(source, "source");
    identifier(id, "id");
    assert(confirmed === true, "confirmationRequired", "删除遗留横幅需要再次确认");
    assert(!this.configured(source), "sourceConfigured", "来源仍在配置中，不能删除其横幅");
    const state = this.states.find(current => current.source === source && current.id === id && current.persistent === true);
    assert(state, "bannerNotFound", "未找到可删除的遗留横幅", 404);
    assert(object(origin) && origin.client === "browser" && typeof origin.connectionId === "string" && origin.connectionId.trim().length > 0, "invalidOrigin", "删除横幅需要浏览器连接信息");
    this.audit({
      action: "removeOrphanBanner",
      at: new Date().toISOString(),
      source,
      id,
      banner: copy(state),
      connectionId: origin.connectionId,
    });
    this.clear(source, id);
  }

  close(): void {
    // 文件写入与审计均同步完成，无需等待后台任务。
  }

  private sorted(): BannerState[] {
    // 数组保存首次设置次序；稳定排序使同级横幅替换后保持位置。
    return [...this.states].sort((a, b) => priority[a.level] - priority[b.level]);
  }

  private persist(states: BannerState[]): void {
    const banners: SavedBanner[] = states.filter(state => state.persistent === true).map(state => ({ ...bannerValue(state), source: state.source }));
    const data = `${JSON.stringify({ version: 1, banners })}\n`;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, data, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // 持久写入失败时，调用方不提交内存状态，也不广播。
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
