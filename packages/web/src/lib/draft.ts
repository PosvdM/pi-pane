// 输入框草稿（image-placeholders.md“输入框”）：文本与原子图片节点的序列。纯逻辑，可在 Node.js 中测试。
import type { DraftNode } from "./types.ts";

/** 合并相邻文本节点，去掉空文本。 */
export function normalize(nodes: DraftNode[]): DraftNode[] {
  const result: DraftNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (!node.text) continue;
      const last = result.at(-1);
      if (last?.type === "text") result[result.length - 1] = { type: "text", text: last.text + node.text };
      else result.push({ type: "text", text: node.text });
    } else result.push({ type: "image", assetId: node.assetId });
  }
  return result;
}

export function isEmpty(nodes: DraftNode[]): boolean {
  return !nodes.some((n) => n.type === "image" || n.text.trim());
}

/** 发给其他程序的纯文本：图片节点按当前编号写成 [Image #n]。 */
export function plainText(nodes: DraftNode[], firstIndex = 1): string {
  let n = firstIndex - 1;
  return nodes.map((node) => node.type === "text" ? node.text : `[Image #${++n}]`).join("");
}

export function imageIds(nodes: DraftNode[]): string[] {
  return nodes.flatMap((n) => n.type === "image" ? [n.assetId] : []);
}

/** 停止或关闭时清出的草稿按原顺序放在现有草稿之前，用空行分隔。 */
export function prependDrafts(restored: DraftNode[][], existing: DraftNode[]): DraftNode[] {
  const parts = [...restored.filter((d) => !isEmpty(d)), ...(isEmpty(existing) ? [] : [existing])];
  const result: DraftNode[] = [];
  parts.forEach((part, i) => { if (i) result.push({ type: "text", text: "\n\n" }); result.push(...part); });
  return normalize(result);
}

/** 服务端编码的图片标记 ⟦pane-img:<nonce>:<k>⟧ 在队列文字中显示为 [Image #k]。 */
export function displayQueued(text: string): string {
  return text.replace(/⟦pane-img:[a-z0-9]{6,8}:(\d+)⟧/g, "[Image #$1]");
}

/** 斜杠命令：返回首个词（不含 "/"）和其余参数；不是斜杠命令时返回 null。 */
export function parseSlash(nodes: DraftNode[]): { name: string; args: string } | null {
  if (nodes.some((n) => n.type === "image")) return null;
  const text = plainText(nodes).trim();
  const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text);
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : null;
}
