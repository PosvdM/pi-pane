import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import type { DraftNode } from "@pi-pane/plugin-api";
import { assert, PaneError } from "./errors.js";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES = 10;
export const MAX_MESSAGE_IMAGE_BYTES = 12 * 1024 * 1024;
const formats: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const extensions: Record<string, string> = Object.fromEntries(Object.entries(formats).map(([ext, mime]) => [mime, ext]));
export function hashId(data: Uint8Array): string { return "sha256-" + createHash("sha256").update(data).digest("hex"); }
export function imageInfo(data: Uint8Array, mime?: string): { mimeType: string; width: number; height: number } {
  let info;
  try { info = imageSize(data); } catch { throw new PaneError("invalidImage", "图片文件头无效"); }
  const mimeType = info.type && formats[info.type];
  assert(mimeType && (!mime || mime === mimeType), "invalidImage", "图片类型不支持或与文件头不符");
  assert(info.width > 0 && info.height > 0, "invalidImage", "图片尺寸无效");
  return { mimeType, width: info.width, height: info.height };
}
export interface AssetMeta { mimeType: string; size: number; width: number; height: number; createdAt: number; lastUsedAt: number }
export class AssetStore {
  private readonly blobs = new Map<string, { mimeType: string; used: number; size: number }>();
  constructor(readonly home: string, readonly maxCacheBytes = 1024 ** 3, private readonly now = Date.now) {
    for (const directory of ["assets", "cache/blobs"]) mkdirSync(path.join(home, directory), { recursive: true, mode: 0o700 });
  }
  private hex(id: string): string { assert(/^sha256-[a-f0-9]{64}$/.test(id), "invalidAssetId", "图片标识格式无效"); return id.slice(7); }
  private metaPath(id: string): string { const hex = this.hex(id); return path.join(this.home, "assets", hex.slice(0, 2), hex + ".json"); }
  upload(data: Buffer, mimeType: string, thumb: Buffer): { assetId: string; width: number; height: number } {
    assert(data.length <= MAX_IMAGE_BYTES, "imageTooLarge", "单张图片不能超过 4 MiB", 413);
    assert(thumb.length <= 512 * 1024, "thumbnailTooLarge", "缩略图不能超过 512 KiB", 413);
    const info = imageInfo(data, mimeType); const thumbnail = imageInfo(thumb, "image/webp");
    assert(Math.max(thumbnail.width, thumbnail.height) <= 256, "invalidThumbnail", "缩略图最长边不能超过 256 像素");
    const assetId = hashId(data); const file = this.metaPath(assetId); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const prefix = file.slice(0, -5); const at = this.now();
    const meta: AssetMeta = { ...info, size: data.length, createdAt: at, lastUsedAt: at };
    if (existsSync(file)) meta.createdAt = this.readMeta(assetId).createdAt;
    writeFileSync(prefix + "." + extensions[mimeType], data, { mode: 0o600 });
    writeFileSync(prefix + ".thumb.webp", thumb, { mode: 0o600 });
    writeFileSync(file, JSON.stringify(meta), { mode: 0o600 });
    return { assetId, width: info.width, height: info.height };
  }
  private readMeta(id: string): AssetMeta {
    try { return JSON.parse(readFileSync(this.metaPath(id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PaneError("assetMissing", "图片已过期，请重新添加", 404); throw error; }
  }
  touch(ids: string[]): { missing: string[] } {
    const missing: string[] = [];
    for (const id of ids) {
      try { const meta = this.readMeta(id); meta.lastUsedAt = this.now(); writeFileSync(this.metaPath(id), JSON.stringify(meta), { mode: 0o600 }); }
      catch (error) { if (error instanceof PaneError && error.code === "assetMissing") missing.push(id); else throw error; }
    }
    return { missing };
  }
  asset(id: string, thumbnail = false): { data: Buffer; mimeType: string } {
    const meta = this.readMeta(id); this.touch([id]);
    return { data: readFileSync(this.metaPath(id).slice(0, -5) + (thumbnail ? ".thumb.webp" : "." + extensions[meta.mimeType])), mimeType: thumbnail ? "image/webp" : meta.mimeType };
  }
  encode(draft: DraftNode[], imageSupported: boolean): { message: string; images: any[] } {
    assert(Array.isArray(draft) && draft.length <= 10000, "invalidDraft", "草稿格式无效");
    const images: any[] = []; let message = ""; let bytes = 0; const nonce = randomBytes(4).toString("hex");
    for (const node of draft) {
      if (node.type === "text") { assert(typeof node.text === "string", "invalidDraft", "草稿文本无效"); message += node.text; }
      else {
        assert(node.type === "image" && imageSupported, "imageUnsupported", "当前模型不支持图片，请切换模型");
        const asset = this.asset(node.assetId); bytes += asset.data.length;
        assert(asset.data.length <= MAX_IMAGE_BYTES, "imageTooLarge", "单张图片不能超过 4 MiB", 413);
        images.push({ type: "image", data: asset.data.toString("base64"), mimeType: asset.mimeType });
        message += `⟦pane-img:${nonce}:${images.length}⟧`;
      }
    }
    assert(images.length <= MAX_MESSAGE_IMAGES && bytes <= MAX_MESSAGE_IMAGE_BYTES, "imagesTooLarge", "一条消息最多 10 张图片且合计不能超过 12 MiB", 413);
    return { message, images };
  }
  /** 入模与分配事件游标在同一同步步骤内完成，快照不会遇到尚未写入的图片引用。 */
  detach<T>(value: T): T {
    const walk = (item: any): any => {
      if (item === null || typeof item !== "object") return item;
      if (Array.isArray(item)) return item.map(walk);
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        const data = Buffer.from(item.data, "base64"); const id = hashId(data); const file = path.join(this.home, "cache/blobs", this.hex(id));
        if (!existsSync(file)) writeFileSync(file, data, { mode: 0o600 });
        this.blobs.set(id, { mimeType: item.mimeType, used: this.now(), size: data.length });
        let dimensions = {};
        try { dimensions = imageInfo(data, item.mimeType); } catch { /* 不支持的类型仅提供下载信息，不作为图片渲染。 */ }
        return { type: "image", mimeType: item.mimeType, blob: id, size: data.length, ...dimensions };
      }
      return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, walk(val)]));
    };
    return walk(value);
  }
  blob(id: string): { data: Buffer; mimeType: string } {
    const file = path.join(this.home, "cache/blobs", this.hex(id)); const meta = this.blobs.get(id);
    assert(meta && existsSync(file), "blobMissing", "图片缓存缺失，请重新读取会话", 404); meta.used = this.now();
    return { data: readFileSync(file), mimeType: meta.mimeType };
  }
  sweep(): void {
    for (const prefix of readdirSync(path.join(this.home, "assets"))) {
      const dir = path.join(this.home, "assets", prefix); if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
        const meta = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as AssetMeta;
        if (meta.lastUsedAt + 7 * 86400000 >= this.now()) continue;
        for (const suffix of [".json", ".thumb.webp", "." + extensions[meta.mimeType]]) {
          try { unlinkSync(path.join(dir, name.slice(0, -5) + suffix)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
    }
    let size = [...this.blobs.values()].reduce((total, item) => total + item.size, 0);
    for (const [id, meta] of [...this.blobs].sort((a, b) => a[1].used - b[1].used)) {
      if (size <= this.maxCacheBytes) break;
      try { unlinkSync(path.join(this.home, "cache/blobs", this.hex(id))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      size -= meta.size; this.blobs.delete(id);
    }
  }
}
