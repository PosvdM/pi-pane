// 按 architecture.md“渲染与资源安全”配置的 Markdown 渲染：
// - 原始 HTML 按文本显示（html: false）；
// - 链接只允许 http:、https:、mailto: 和页面内锚点，其他 scheme 只保留文字；
// - 外部链接 rel="noopener noreferrer"、target="_blank"；
// - 远程图片不加载，显示为链接“远程图片：<域名>”；
// - 代码块用 highlight.js 高亮。
import MarkdownIt from 'markdown-it';
import hljs from 'virtual-hljs';

const SAFE_LINK = /^(https?:|mailto:|#)/i;

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
    }
    return '';
  },
});

// markdown-it 自带的 validateLink 会拒绝 javascript:、vbscript:、file: 和大部分 data:，
// 这里收紧为白名单；不通过的链接由 markdown-it 按普通文字输出。
md.validateLink = (url) => SAFE_LINK.test(url.trim());

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? '';
  if (!href.startsWith('#')) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.image = (tokens, idx) => {
  const src = tokens[idx].attrGet('src') ?? '';
  let host = '';
  try {
    host = new URL(src).host;
  } catch {}
  const label = md.utils.escapeHtml(`远程图片：${host || src}`);
  return `<a href="${md.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
};

export function renderMarkdown(text) {
  return md.render(text);
}
