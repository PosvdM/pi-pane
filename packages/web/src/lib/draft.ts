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

/** 草稿的单元序列：文本拆成 UTF-16 码元，图片为一个单元。用于按前缀、后缀比较两份草稿。 */
type Unit = string | { image: string };
const units = (nodes: DraftNode[]): Unit[] => normalize(nodes).flatMap((n): Unit[] => n.type === "text" ? n.text.split("") : [{ image: n.assetId }]);
const sameUnit = (a: Unit, b: Unit) => typeof a === "string" ? a === b : typeof b !== "string" && a.image === b.image;
const fromUnits = (list: Unit[]): DraftNode[] => normalize(list.map((u) => typeof u === "string" ? { type: "text" as const, text: u } : { type: "image" as const, assetId: u.image }));
function startsWith(list: Unit[], head: Unit[]): boolean { return head.length <= list.length && head.every((u, i) => sameUnit(u, list[i])); }
function endsWith(list: Unit[], tail: Unit[]): boolean { const offset = list.length - tail.length; return offset >= 0 && tail.every((u, i) => sameUnit(u, list[offset + i])); }
const sameDraft = (a: Unit[], b: Unit[]) => a.length === b.length && startsWith(a, b);

/**
 * 两个标签页基于同一份草稿 base 各自修改后的合并（architecture.md“取回草稿的交付”）：本页内容 local，存储中另一页写入的内容 stored。
 * 宁可重复，不可丢失：
 * 1. 一方与 base 相同时取另一方；两方相同时取其一。
 * 2. local 只在 base 的末尾（开头）增加了内容时，把增加的部分接到 stored 的末尾（开头）。
 * 3. stored 只在 base 的末尾（开头）增加了内容时，把增加的部分接到 local 的末尾（开头）。
 * 4. 其余情况（包括 base 为空）两份都保留：stored 在前，local 在后，用空行分隔。
 */
export function mergeDrafts(base: DraftNode[], local: DraftNode[], stored: DraftNode[]): DraftNode[] {
  const b = units(base); const l = units(local); const s = units(stored);
  if (sameDraft(l, s) || sameDraft(l, b)) return fromUnits(s);
  if (sameDraft(s, b)) return fromUnits(l);
  if (b.length && !isEmpty(base)) {
    if (startsWith(l, b)) return fromUnits([...s, ...l.slice(b.length)]);
    if (endsWith(l, b)) return fromUnits([...l.slice(0, l.length - b.length), ...s]);
    if (startsWith(s, b)) return fromUnits([...l, ...s.slice(b.length)]);
    if (endsWith(s, b)) return fromUnits([...s.slice(0, s.length - b.length), ...l]);
  }
  if (isEmpty(stored)) return fromUnits(l);
  if (isEmpty(local)) return fromUnits(s);
  return normalize([...stored, { type: "text", text: "\n\n" }, ...local]);
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
