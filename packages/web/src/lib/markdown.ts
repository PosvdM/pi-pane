// 不可信内容的 Markdown 渲染（architecture.md“渲染与资源安全”）：
// - 原始 HTML 按文本显示；
// - 链接只允许 http:、https:、mailto: 和页面内锚点，其他 scheme 只保留文字；外部链接在新标签页打开并带 noopener noreferrer；
// - Markdown 中的图片不加载，显示为链接“远程图片：<域名>”，地址不安全时只显示文字；
// - 代码块用 highlight.js 的 common 语言集高亮，输出只有 class，没有内联样式。
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

const SAFE_LINK = /^(https?:|mailto:|#)/i;
type Md = InstanceType<typeof MarkdownIt>;
const md: Md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code: string, lang: string): string {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    const body = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : md.utils.escapeHtml(code);
    return `<pre class="hljs"><code>${body}</code></pre>`;
  },
});
md.validateLink = (url: string) => SAFE_LINK.test(url.trim());

type Rule = NonNullable<Md["renderer"]["rules"]["link_open"]>;
const defaultLinkOpen: Rule = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = ((tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet("href") ?? "");
  if (!href.startsWith("#")) { tokens[idx].attrSet("target", "_blank"); tokens[idx].attrSet("rel", "noopener noreferrer"); }
  return defaultLinkOpen(tokens, idx, options, env, self);
}) as Rule;
md.renderer.rules.image = ((tokens, idx) => {
  const src = String(tokens[idx].attrGet("src") ?? "").trim();
  let host = "";
  try { host = new URL(src).host; } catch { /* 相对地址或非法地址只显示原文。 */ }
  const label = md.utils.escapeHtml(`远程图片：${host || src}`);
  if (!/^https?:/i.test(src)) return `<span class="remote-image">${label}</span>`;
  return `<a class="remote-image" href="${md.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}) as Rule;

const cache = new Map<string, string>();
export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = md.render(text);
  if (text.length < 200000) { cache.set(text, html); if (cache.size > 500) cache.delete(cache.keys().next().value!); }
  return html;
}
