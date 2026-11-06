// pi-pane 前端骨架（pane P0 #14）：Preact + Markdown 渲染 + 代码高亮，用于测量打包体积，
// 并在 CSP 下实际加载，确认没有内联脚本和 eval。
import { render } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import { renderMarkdown } from './markdown.js';
import './style.css';

const SAMPLE = [
  '# 渲染示例',
  '',
  '普通段落，含 **粗体**、`行内代码` 和链接 [pi](https://example.com/pi)。',
  '',
  '- [危险链接](javascript:alert(1))',
  '- [data 链接](data:text/html,<b>x</b>)',
  '- [锚点](#top)',
  '- <img src=x onerror="window.__xss=1"> 原始 HTML',
  '',
  '![远程图片](https://tracker.example.net/pixel.png?q=secret)',
  '',
  '```ts',
  'export function add(a: number, b: number): number {',
  '  return a + b; // comment',
  '}',
  '```',
  '',
  '```python',
  'def greet(name: str) -> str:',
  '    return f"hello {name}"',
  '```',
].join('\n');

function Message({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="msg" dangerouslySetInnerHTML={{ __html: html }} />;
}

function App() {
  const [messages, setMessages] = useState([SAMPLE]);
  const [draft, setDraft] = useState('');
  return (
    <main>
      <section id="messages">
        {messages.map((m, i) => (
          <Message key={i} text={m} />
        ))}
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setMessages([...messages, draft]);
          setDraft('');
        }}
      >
        <textarea value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
        <button type="submit">发送</button>
      </form>
    </main>
  );
}

const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
// 供测试驱动读取（与 lib/browsers.mjs 的 tab.call 约定一致）。
window.__f = {
  violations: () => violations,
  rendered: () => document.getElementById('messages')?.innerHTML ?? '',
  xss: () => window.__xss === 1,
};

render(<App />, document.getElementById('app'));
