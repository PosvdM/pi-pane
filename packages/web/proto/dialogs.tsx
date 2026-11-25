// 弹窗：持久表单（plugin-api.md“表单”）与用户在场确认（“用户在场确认”）。
import { useState } from "preact/hooks";
import type { FormQuestion, FormSpec } from "@pi-pane/plugin-api";
import { Markdown } from "../src/components/Message.tsx";
import { PRESENCE } from "./data.ts";
import { left, nodeTitle, when } from "./tree.tsx";

/** 与现有 Modal 同样的结构和样式；标题栏右侧放调用方给的按钮（如“稍后处理”）。 */
function Shell({ title, aside, children, testid, wide, extra }: { title: any; aside?: any; children: any; testid: string; wide?: boolean; extra?: string }) {
  return (
    <div class="modal-back">
      <div class={"modal" + (wide ? " wide" : "") + (extra ? " " + extra : "")} role="dialog" data-testid={testid}>
        <div class="modal-head"><span>{title}</span>{aside}</div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

type Answer = { selected: string[]; custom?: string };

function Question({ q, value, onChange }: { q: FormQuestion; value: Answer; onChange: (a: Answer) => void }) {
  const toggle = (label: string) => {
    const has = value.selected.includes(label);
    onChange(q.multiSelect ? { ...value, selected: has ? value.selected.filter((s) => s !== label) : [...value.selected, label] } : { selected: has ? [] : [label] });
  };
  const custom = value.custom !== undefined;
  return (
    <div class="form-q">
      {q.header && <div class="q-header">{q.header}{q.multiSelect ? " · 可多选" : ""}</div>}
      <Markdown text={q.question} />
      <div class="options">
        {q.options?.map((o) => (
          <button key={o.label} class={"option q-option" + (value.selected.includes(o.label) ? " active" : "")} onClick={() => toggle(o.label)}>
            <span class={"q-mark" + (q.multiSelect ? " multi" : "")}>{value.selected.includes(o.label) ? (q.multiSelect ? "☑" : "◉") : (q.multiSelect ? "☐" : "○")}</span>
            <span class="q-text"><span>{o.label}{o.recommended && <span class="rec">推荐</span>}</span>{o.description && <span class="muted small">{o.description}</span>}</span>
          </button>
        ))}
        {q.allowCustom !== false && (
          <div class={"option q-option q-custom" + (custom ? " active" : "")} onClick={() => !custom && onChange({ selected: q.multiSelect ? value.selected : [], custom: "" })}>
            <span class="q-mark">{custom ? "◉" : "○"}</span>
            {custom
              ? <input class="text-input" placeholder="其他：输入你的答复" value={value.custom} onInput={(e) => onChange({ ...value, custom: e.currentTarget.value })} />
              : <span class="muted">其他（自由输入）</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function FormDialog({ form, initial, onLater, onSubmit }: { form: FormSpec; initial?: Record<string, Answer>; onLater: () => void; onSubmit: () => void }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(initial ?? {});
  const expiry = left(form.expiresAt);
  return (
    <Shell testid="form-dialog" wide title={form.title} aside={<button class="btn ghost later" onClick={onLater} title="关闭弹窗，事项留在待处理区">稍后处理</button>}>
      <div class="form-meta muted small">
        <span class="src-tag">{form.source}</span> {when(form.createdAt)}
        {expiry && <> · <span class="expiry">{expiry}</span></>}
        {form.nodeId && <> · 关联：<button class="link">{nodeTitle(form.nodeId)} ↗</button></>}
      </div>
      {form.description && <Markdown text={form.description} />}
      {form.questions?.map((q) => <Question key={q.id} q={q} value={answers[q.id] ?? { selected: [] }} onChange={(a) => setAnswers({ ...answers, [q.id]: a })} />)}
      <div class="modal-actions form-actions">
        {form.cancel && <button class="btn danger ghost" title="提交“取消”结果，插件不会当作同意">{form.cancel.label}</button>}
        <span class="spacer" />
        <button class="btn primary" onClick={onSubmit}>{form.submitLabel ?? "提交"}</button>
      </div>
    </Shell>
  );
}

export function PresenceDialog({ onClose, showPayload = false }: { onClose: () => void; showPayload?: boolean }) {
  const { request, plugin, device } = PRESENCE;
  const [raw, setRaw] = useState(showPayload);
  return (
    <Shell testid="presence-dialog" extra="presence" title={<span class="presence-title"><span class="lock">🔐</span>需要你确认：{request.title}</span>}>
      <div class="form-meta muted small"><span class="src-tag">{plugin}</span> 在本标签页发起 · 118 秒后超时，超时视为未确认</div>
      <Markdown text={request.summary} />
      <table class="kv presence-kv">
        <tbody>
          <tr><th>签名设备</th><td>{device.label}（本设备） · <code>{device.deviceId}</code></td></tr>
          <tr><th>算法</th><td>{device.alg}</td></tr>
        </tbody>
      </table>
      <button class="link small" onClick={() => setRaw(!raw)}>{raw ? "▾" : "▸"} 签名内容（payload 原文）</button>
      {raw && <pre class="plain payload">{JSON.stringify(request.payload, null, 2)}</pre>}
      <div class="modal-actions">
        <button class="btn" onClick={onClose}>拒绝</button>
        <button class="btn primary" onClick={onClose}>确认并签名</button>
      </div>
    </Shell>
  );
}
