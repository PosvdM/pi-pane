// 图片上传（image-placeholders.md“上传”）：浏览器内缩放、生成缩略图，multipart 上传得到 assetId。
import { request, newId } from "./api.ts";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES = 10;
export const MAX_MESSAGE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 2000;
const THUMB_EDGE = 256;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface UploadedAsset { assetId: string; width: number; height: number; size: number; mimeType: string; note?: string }
/** 本标签页上传过的资源，用于发送前校验大小。 */
export const assetMeta = new Map<string, UploadedAsset>();

function canvasBlob(bitmap: ImageBitmap, edge: number, type: string, quality?: number): Promise<Blob> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片编码失败")), type, quality));
}

export async function uploadImage(file: Blob): Promise<UploadedAsset> {
  if (!TYPES.includes(file.type)) throw new Error("只支持 PNG、JPEG、GIF、WebP 图片");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("无法读取图片"); }
  let image: Blob = file; let note: string | undefined;
  try {
    if (Math.max(bitmap.width, bitmap.height) > MAX_EDGE || file.size > MAX_IMAGE_BYTES) {
      const type = file.type === "image/gif" ? "image/png" : file.type;
      if (file.type === "image/gif") note = "GIF 已缩放，只保留第一帧并转为 PNG";
      image = await canvasBlob(bitmap, MAX_EDGE, type, 0.9);
    }
    if (image.size > MAX_IMAGE_BYTES) throw new Error("图片缩放后仍超过 4 MiB，无法添加");
    const thumb = await canvasBlob(bitmap, THUMB_EDGE, "image/webp", 0.8);
    const form = new FormData();
    form.append("image", image, "image");
    form.append("thumb", thumb, "thumb.webp");
    const response = await request("/api/assets", { method: "POST", body: form, headers: { "X-Request-Id": newId() } });
    const body = await response.json() as { assetId: string; width: number; height: number };
    const asset = { ...body, size: image.size, mimeType: image.type, note };
    assetMeta.set(asset.assetId, asset);
    return asset;
  } finally { bitmap.close(); }
}

/** 发送前校验：数量与合计大小（只能核对本标签页上传过的资源，其余由服务端核对）。 */
export function checkImages(ids: string[]): string | null {
  if (ids.length > MAX_MESSAGE_IMAGES) return "一条消息最多 10 张图片";
  const total = ids.reduce((sum, id) => sum + (assetMeta.get(id)?.size ?? 0), 0);
  if (total > MAX_MESSAGE_IMAGE_BYTES) return "图片合计不能超过 12 MiB";
  return null;
}
