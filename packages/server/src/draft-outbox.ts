// 服务端暂存的清出草稿（architecture.md“服务端暂存的清出草稿”）：停止、关闭、服务端关停或写者停止时从 pi 队列清出的草稿，
// 按会话保存在数据目录的 drafts/ 下。记录是这些草稿唯一的权威副本，浏览器领取（claim）时原子地删除记录并取得内容。
// 每条记录一个文件：drafts/<会话 id 的 SHA-256>/<记录 id 的 SHA-256>.json，写临时文件后原子替换。
// 进程内不加锁：保存、领取和清理之间只依赖文件系统的原子 rename，一个挂起的文件操作不会拖住其他操作。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DraftNode } from "@pi-pane/plugin-api";

/** stop、close：浏览器的停止或关闭请求，记录 id 为该请求的 requestId；shutdown：服务端关停；exit：写者因其他原因停止。 */
export type SavedDraftsReason = "stop" | "close" | "shutdown" | "exit";
export interface SavedDraft { nodes: DraftNode[]; uncertain: boolean }
export interface SavedDrafts { id: string; reason: SavedDraftsReason; at: string; drafts: SavedDraft[] }

/** 未领取的记录保留 30 天，之后由定期清理删除。 */
export const SAVED_DRAFTS_RETENTION_MS = 30 * 86_400_000;
/** 写入中断留下的临时文件、领取中断留下的领取中文件，超过 1 小时后删除。 */
const TEMP_RETENTION_MS = 3_600_000;
const REASONS = new Set<SavedDraftsReason>(["stop", "close", "shutdown", "exit"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const missing = (error: unknown) => code(error) === "ENOENT";
/** 领取中文件：<记录文件>.<领取时间>-<随机串>.claiming。改名保留原文件的修改时间，清理按名称中的领取时间计算。 */
const CLAIMING = /\.(\d+)-[0-9a-f-]+\.claiming$/;

/** 校验并取出一条记录；不符合格式或不属于该会话时为 undefined。 */
function parseRecord(value: any, sessionId: string): SavedDrafts | undefined {
  if (value?.version !== 1 || value.sessionId !== sessionId || typeof value.id !== "string" || !REASONS.has(value.reason) || typeof value.at !== "string" || !Array.isArray(value.drafts)) return undefined;
  const drafts = value.drafts.filter((draft: any) => Array.isArray(draft?.nodes)).map((draft: any) => ({ nodes: draft.nodes, uncertain: draft.uncertain === true }));
  return { id: value.id, reason: value.reason, at: value.at, drafts };
}
function imageIds(drafts: readonly { nodes?: unknown }[]): string[] {
  return drafts.flatMap((draft) => Array.isArray(draft?.nodes) ? draft.nodes.flatMap((node: any) => node?.type === "image" && typeof node.assetId === "string" ? [node.assetId] : []) : []);
}

export class DraftOutbox {
  readonly root: string;
  private readonly listeners = new Set<(sessionId: string) => void>();
  constructor(home: string, private readonly now = Date.now) { this.root = path.join(home, "drafts"); }
  private directory(sessionId: string): string { return path.join(this.root, digest(sessionId)); }
  private file(sessionId: string, id: string): string { return path.join(this.directory(sessionId), digest(id) + ".json"); }
  /** 订阅记录的增删，回调收到会话 id；返回取消订阅的函数。 */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(sessionId: string): void {
    for (const listener of [...this.listeners]) { try { listener(sessionId); } catch { /* 通知失败不影响存储。 */ } }
  }

  /** 保存一条记录；没有草稿时不写入。同一 id 再次保存时替换原记录。 */
  async save(sessionId: string, record: Omit<SavedDrafts, "at">): Promise<void> {
    if (!record.drafts.length) return;
    const file = this.file(sessionId, record.id); const temporary = `${file}.${randomUUID()}.tmp`;
    const data = JSON.stringify({ version: 1, sessionId, id: record.id, reason: record.reason, at: new Date(this.now()).toISOString(), drafts: record.drafts });
    // 清理会删除空的会话目录，可能落在 mkdir 之后、写临时文件之前，写入随之失败（macOS 上为 EINVAL，其他平台为 ENOENT）：
    // 重建目录后重试。临时文件写入后目录不再为空，不会被删除。
    for (let attempt = 1; ; attempt++) {
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, data, { mode: 0o600 });
        break;
      } catch (error) { if (attempt >= 5 || !["ENOENT", "EINVAL"].includes(code(error) ?? "")) throw error; }
    }
    try { await rename(temporary, file); }
    catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
    this.changed(sessionId);
  }

  /** 该会话的全部记录，按保存时间排序。无法解析或不属于该会话的文件跳过，由定期清理删除。 */
  async list(sessionId: string): Promise<SavedDrafts[]> {
    const directory = this.directory(sessionId); let names: string[];
    try { names = await readdir(directory); } catch (error) { if (missing(error)) return []; throw error; }
    const records: SavedDrafts[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let value: unknown;
      // 读取期间可能被领取（改名）或清理。
      try { value = JSON.parse(await readFile(path.join(directory, name), "utf8")); }
      catch (error) { if (missing(error) || error instanceof SyntaxError || code(error) === "EISDIR") continue; throw error; }
      const record = parseRecord(value, sessionId);
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  /**
   * 领取一条记录：把记录文件原子地改名为领取中文件，再读出内容并删除。并发领取同一条时只有一个改名成功，
   * 其他调用以及记录已被领取、清理或不存在时返回 undefined。
   * 删除领取中文件之前调用 touch（记录中图片的 assetId）：领取中文件仍算作图片引用（见 assets），
   * touch 刷新使用时间后，附件从领取时起按普通期限计算。
   */
  async claim(sessionId: string, id: string, touch?: (assetIds: string[]) => void): Promise<SavedDrafts | undefined> {
    const file = this.file(sessionId, id); const claiming = `${file}.${this.now()}-${randomUUID()}.claiming`;
    try { await rename(file, claiming); } catch (error) { if (missing(error)) return undefined; throw error; }
    let record: SavedDrafts | undefined;
    try { record = parseRecord(JSON.parse(await readFile(claiming, "utf8")), sessionId); }
    catch (error) {
      // 读不出内容时放回原处，记录仍可再次领取。
      await rename(claiming, file).catch(() => {});
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (!record) { await rename(claiming, file).catch(() => {}); return undefined; }
    try { touch?.(imageIds(record.drafts)); } catch { /* 刷新失败不影响领取，附件按原使用时间计算。 */ }
    // 删除失败时领取中文件由定期清理删除；内容已交给领取者。
    await rm(claiming, { force: true }).catch(() => {});
    this.changed(sessionId);
    return record;
  }

  /** 全部记录和领取中文件中引用的图片 assetId。附件清理跳过这些图片，见 AssetStore.sweep。读取出错时抛错，由调用方放弃本次附件清理。 */
  async assets(): Promise<Set<string>> {
    const found = new Set<string>();
    for (const directory of await this.directories()) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !(entry.name.endsWith(".json") || CLAIMING.test(entry.name))) continue;
        let value: any;
        try { value = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")); }
        catch (error) { if (missing(error) || error instanceof SyntaxError) continue; throw error; }
        for (const assetId of imageIds(Array.isArray(value?.drafts) ? value.drafts : [])) found.add(assetId);
      }
    }
    return found;
  }

  /** 删除超过保留期限的记录、中断写入留下的临时文件和中断领取留下的领取中文件，以及空的会话目录。单个文件出错时跳过。 */
  async sweep(): Promise<void> {
    for (const directory of await this.directories()) {
      let names: string[];
      try { names = await readdir(directory); } catch { continue; }
      for (const name of names) {
        const file = path.join(directory, name);
        try {
          const claimed = CLAIMING.exec(name);
          if (claimed) { if (this.now() - Number(claimed[1]) > TEMP_RETENTION_MS) await rm(file, { force: true }); continue; }
          const limit = name.endsWith(".tmp") ? TEMP_RETENTION_MS : SAVED_DRAFTS_RETENTION_MS;
          const info = await stat(file);
          if (info.isFile() && this.now() - info.mtimeMs > limit) await rm(file, { force: true });
        } catch { /* 下次清理重试。 */ }
      }
      await rmdir(directory).catch(() => {});
    }
  }

  /** drafts/ 下的会话目录。其他条目（如系统生成的 .DS_Store）忽略。 */
  private async directories(): Promise<string[]> {
    try { return (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(this.root, entry.name)); }
    catch (error) { if (missing(error)) return []; throw error; }
  }
}
