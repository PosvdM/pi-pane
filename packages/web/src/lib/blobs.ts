// 会话图片与上传资源：<img> 不能带 Authorization 头，用 fetch 取回后转成 blob: URL，按地址缓存。
import { useEffect, useState } from "preact/hooks";
import { request } from "./api.ts";

const cache = new Map<string, Promise<string>>();
export const DISPLAYABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function blobUrl(path: string): Promise<string> {
  let hit = cache.get(path);
  if (!hit) {
    hit = request(path).then((r) => r.blob()).then((blob) => URL.createObjectURL(blob));
    hit.catch(() => cache.delete(path));
    cache.set(path, hit);
  }
  return hit;
}

export function useBlobUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    blobUrl(path).then((value) => { if (alive) setUrl(value); }, () => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [path]);
  return url;
}
