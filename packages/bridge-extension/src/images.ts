export function restoreImages(message: any): { message?: any; invalid?: boolean } {
  if (message.role !== "user" || !Array.isArray(message.content)) return {};
  const text = message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  if (!text.includes("⟦pane-img:")) return {};
  const marks = [...text.matchAll(/⟦pane-img:([a-z0-9]{6,8}):(\d+)⟧/g)];
  const images = message.content.filter((b: any) => b.type === "image");
  if (!marks.length || marks.length !== images.length || marks.some((m, i) => m[1] !== marks[0][1] || Number(m[2]) !== i + 1)) return { invalid: true };
  let offset = 0; const content: any[] = [];
  for (const [i, mark] of marks.entries()) {
    content.push({ type: "text", text: text.slice(offset, mark.index) + `[Image #${i + 1}]` }, images[i]); offset = mark.index! + mark[0].length;
  }
  if (offset < text.length) content.push({ type: "text", text: text.slice(offset) });
  return { message: { ...message, content } };
}
