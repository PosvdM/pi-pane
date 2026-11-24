import type { Entry } from "./store.js";

export function normalizeSessionName(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** 文本块按存储目录的提取规则连接；没有文本的用户消息不占据回退位置。 */
export function firstUserText(entries: readonly Entry[]): string {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join(" ") : "";
    if (text) return text;
  }
  return "";
}

export function fallbackSessionTitle(firstText: unknown, fallback: string): string {
  const text = typeof firstText === "string" ? firstText.trim() : "";
  let title = ""; let length = 0;
  for (const character of text) { if (length++ === 200) break; title += character; }
  return title || fallback;
}

export function sessionTitle(name: unknown, firstText: unknown, id: string): string {
  return normalizeSessionName(name) ?? fallbackSessionTitle(firstText, id);
}

