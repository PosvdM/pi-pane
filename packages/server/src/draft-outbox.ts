// 服务端暂存的清出草稿（architecture.md“服务端暂存的清出草稿”）：停止、关闭或服务端关停时从 pi 队列清出、
// 尚未确认交到浏览器的草稿，按会话保存在数据目录的 drafts/ 下，浏览器取回后删除。
// 每条记录一个文件：drafts/<会话 id 的 SHA-256>/<记录 id 的 SHA-256>.json，写临时文件后原子替换。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DraftNode } from "@pi-pane/plugin-api";

/** stop、close：浏览器的停止或关闭请求，记录 id 为该请求的 requestId；shutdown：服务端关停；exit：写者因其他原因停止。 */
export type SavedDraftsReason = "stop" | "close" | "shutdown" | "exit";
export interface SavedDraft { nodes: DraftNode[]; uncertain: boolean }
export interface SavedDrafts { id: string; reason: SavedDraftsReason; at: string; drafts: SavedDraft[] }

/** 未取回的记录保留 30 天，之后由定期清理删除。 */
export const SAVED_DRAFTS_RETENTION_MS = 30 * 86_400_000;
/** 写入中断留下的临时文件超过 1 小时后删除。 */
const TEMP_RETENTION_MS = 3_600_000;
const REASONS = new Set<SavedDraftsReason>(["stop", "close", "shutdown", "exit"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class DraftOutbox {
  readonly root: string;
  /** 每个会话目录上的写入、删除和清理按调用顺序串行，见 exclusive。 */
  private readonly queues = new Map<string, Promise<void>>();
  constructor(home: string, private readonly now = Date.now) { this.root = path.join(home, "drafts"); }
  /**
   * 在会话目录上串行执行。remove() 和 sweep() 会删除空的会话目录，与 save() 交错时可能落在 mkdir 之后、写临时文件之前，
   * 写入随之失败（macOS 上为 EINVAL，其他平台为 ENOENT）。数据目录只由持有实例锁的一个服务端进程使用，进程内串行即可。
   */
  private exclusive<T>(directory: string, action: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(directory) ?? Promise.resolve()).then(action);
    const tail = result.then(() => {}, () => {});
    this.queues.set(directory, tail);
    void tail.then(() => { if (this.queues.get(directory) === tail) this.queues.delete(directory); });
    return result;
  }
  private directory(sessionId: string): string { return path.join(this.root, digest(sessionId)); }
  private file(sessionId: string, id: string): string { return path.join(this.directory(sessionId), digest(id) + ".json"); }

  /** 保存一条记录；没有草稿时不写入。同一 id 再次保存时替换原记录。 */
  async save(sessionId: string, record: Omit<SavedDrafts, "at">): Promise<void> {
    if (!record.drafts.length) return;
    const file = this.file(sessionId, record.id); const temporary = `${file}.${randomUUID()}.tmp`;
    const data = JSON.stringify({ version: 1, sessionId, id: record.id, reason: record.reason, at: new Date(this.now()).toISOString(), drafts: record.drafts });
    await this.exclusive(this.directory(sessionId), async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, data, { mode: 0o600 });
      try { await rename(temporary, file); }
      catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
    });
  }

  /** 该会话的全部记录，按保存时间排序。无法解析或不属于该会话的文件跳过，由定期清理删除。 */
  async list(sessionId: string): Promise<SavedDrafts[]> {
    const directory = this.directory(sessionId); let names: string[];
    try { names = await readdir(directory); } catch (error) { if (missing(error)) return []; throw error; }
    const records: SavedDrafts[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let value: any;
      try { value = JSON.parse(await readFile(path.join(directory, name), "utf8")); }
      catch (error) { if (missing(error) || error instanceof SyntaxError) continue; throw error; }
      if (value?.version !== 1 || value.sessionId !== sessionId || typeof value.id !== "string" || !REASONS.has(value.reason) || typeof value.at !== "string" || !Array.isArray(value.drafts)) continue;
      const drafts = value.drafts.filter((draft: any) => Array.isArray(draft?.nodes)).map((draft: any) => ({ nodes: draft.nodes, uncertain: draft.uncertain === true }));
      records.push({ id: value.id, reason: value.reason, at: value.at, drafts });
    }
    return records.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  /** 删除记录；不存在的 id 忽略。 */
  async remove(sessionId: string, ids: readonly string[]): Promise<void> {
    await this.exclusive(this.directory(sessionId), async () => {
      for (const id of ids) await rm(this.file(sessionId, id), { force: true });
      // 目录为空时一并删除；仍有记录时保留。
      await rmdir(this.directory(sessionId)).catch(() => {});
    });
  }

  /** 全部记录中引用的图片 assetId。附件清理跳过这些图片，见 AssetStore.sweep。无法读取的目录或文件抛错，由调用方放弃本次附件清理。 */
  async assets(): Promise<Set<string>> {
    const found = new Set<string>(); let directories: string[];
    try { directories = await readdir(this.root); } catch (error) { if (missing(error)) return found; throw error; }
    for (const directory of directories) {
      const full = path.join(this.root, directory); let names: string[];
      try { names = await readdir(full); } catch (error) { if (missing(error)) continue; throw error; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        let value: any;
        try { value = JSON.parse(await readFile(path.join(full, name), "utf8")); }
        catch (error) { if (missing(error) || error instanceof SyntaxError) continue; throw error; }
        for (const draft of Array.isArray(value?.drafts) ? value.drafts : []) {
          for (const node of Array.isArray(draft?.nodes) ? draft.nodes : []) if (node?.type === "image" && typeof node.assetId === "string") found.add(node.assetId);
        }
      }
    }
    return found;
  }

  /** 删除超过保留期限的记录和中断写入留下的临时文件。 */
  async sweep(): Promise<void> {
    let directories: string[];
    try { directories = await readdir(this.root); } catch (error) { if (missing(error)) return; throw error; }
    for (const directory of directories) {
      const full = path.join(this.root, directory);
      await this.exclusive(full, async () => {
        let names: string[];
        try { names = await readdir(full); } catch { return; }
        for (const name of names) {
          const file = path.join(full, name); const limit = name.endsWith(".tmp") ? TEMP_RETENTION_MS : SAVED_DRAFTS_RETENTION_MS;
          try { if (this.now() - (await stat(file)).mtimeMs > limit) await rm(file, { force: true }); }
          catch (error) { if (!missing(error)) throw error; }
        }
        await rmdir(full).catch(() => {});
      });
    }
  }
}
