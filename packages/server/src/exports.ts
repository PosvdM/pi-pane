import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { assert, PaneError } from "./errors.js";

const lifetime = 24 * 60 * 60 * 1000;
const validId = (id: string) => /^[A-Za-z0-9_-]{21}[AQgw]$/.test(id);
/** 下载权限仅保存在当前实例的内存中；目录中的其他文件不授予下载权限。 */
export class ExportStore {
  readonly directory: string;
  private readonly generated = new Map<string, { createdAt: number; ready: boolean }>();
  constructor(home: string) { this.directory = path.join(home, "tmp", "exports"); }
  async allocate(): Promise<{ id: string; outputPath: string }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomBytes(16).toString("base64url");
    this.generated.set(id, { createdAt: Date.now(), ready: false });
    return { id, outputPath: path.join(this.directory, id + ".html") };
  }
  complete(id: string): void { const record = this.generated.get(id); if (record) record.ready = true; }
  async download(id: string): Promise<Buffer> {
    assert(validId(id), "invalidExportId", "导出标识格式无效");
    const record = this.generated.get(id);
    assert(record?.ready && Date.now() - record.createdAt < lifetime, "exportMissing", "导出文件不存在或已过期", 404);
    const file = path.join(this.directory, id + ".html");
    try {
      assert((await lstat(file)).isFile(), "exportMissing", "导出文件不存在", 404);
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PaneError("exportMissing", "导出文件不存在", 404);
      throw error;
    }
  }
  async sweep(now = Date.now()): Promise<void> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const file of files) {
      const id = file.endsWith(".html") ? file.slice(0, -5) : "";
      if (!validId(id)) continue;
      const full = path.join(this.directory, file); const record = this.generated.get(id);
      try {
        const info = await lstat(full);
        if (now - (record?.createdAt ?? info.mtimeMs) < lifetime) continue;
        await rm(full, { force: true }); this.generated.delete(id);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const [id, record] of this.generated) if (now - record.createdAt >= lifetime) this.generated.delete(id);
  }
}
