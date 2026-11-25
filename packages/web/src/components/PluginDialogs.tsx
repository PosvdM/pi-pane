// 插件交给浏览器的弹窗与提示：表单、用户在场确认、横幅、通知、结果未知的动作（plugin-api.md“表单”“用户在场确认”“横幅”“通知”“动作”）。
import { useEffect, useRef, useState } from "preact/hooks";
import { getOrCreateDevice, type DeviceInfo } from "../lib/device-key.ts";
import { openNodeById } from "../lib/navigate.ts";
import {
  answerPresence, banners, dismissNotification, formBusy, notifications, openForm, pendingActions, presence, queryAction, queryForm, runAction, submitForm,
} from "../lib/plugin-ui.ts";
import { actionSpec, pluginName, plugins } from "../lib/plugins.ts";
import { useStore } from "../lib/store.ts";
import type { BannerState, FieldGroupValue, FieldValue, FormAnswers, FormField, FormQuestion, FormSpec } from "../lib/types.ts";
import { Markdown } from "./Message.tsx";
import { expiresIn, nodeTitle, when } from "./Sidebar.tsx";

/** 与 Modal 相同的结构；标题栏右侧放调用方给的按钮（如“稍后处理”）。 */
function Shell({ title, aside, children, testid, extra }: { title: any; aside?: any; children: any; testid: string; extra?: string }) {
  return (
    <div class="modal-back">
      <div class={"modal wide" + (extra ? " " + extra : "")} role="dialog" data-testid={testid}>
        <div class="modal-head"><span>{title}</span>{aside}</div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

type Answer = { selected: string[]; custom?: string };

/** dependsOn：所依赖的题目选中了指定值（省略 value 时只要有答案）才显示。 */
function shown(q: FormQuestion, answers: Record<string, Answer>): boolean {
  if (!q.dependsOn) return true;
  const answer = answers[q.dependsOn.questionId];
  const values = answer ? [...answer.selected, ...(answer.custom ? [answer.custom] : [])] : [];
  if (q.dependsOn.value === undefined) return values.length > 0;
  const want = Array.isArray(q.dependsOn.value) ? q.dependsOn.value : [q.dependsOn.value];
  return want.some((v) => values.includes(v));
}

function Question({ q, value, onChange }: { q: FormQuestion; value: Answer; onChange: (a: Answer) => void }) {
  const toggle = (label: string) => {
    const has = value.selected.includes(label);
    onChange(q.multiSelect ? { ...value, selected: has ? value.selected.filter((s) => s !== label) : [...value.selected, label] } : { selected: has ? [] : [label] });
  };
  const custom = value.custom !== undefined;
  const options = q.options ?? [];
  return (
    <div class="form-q" data-testid="form-question" data-question-id={q.id}>
      {q.header && <div class="q-header">{q.header}{q.multiSelect ? " · 可多选" : ""}</div>}
      <Markdown text={q.question} />
      {q.detail && <div class="muted small"><Markdown text={q.detail} /></div>}
      <div class="options">
        {options.map((o) => (
          <button key={o.label} type="button" class={"option q-option" + (value.selected.includes(o.label) ? " active" : "")} data-testid="form-option" onClick={() => toggle(o.label)}>
            <span class="q-mark">{value.selected.includes(o.label) ? (q.multiSelect ? "☑" : "◉") : (q.multiSelect ? "☐" : "○")}</span>
            <span class="q-text"><span>{o.label}{o.recommended && <span class="rec">推荐</span>}</span>{o.description && <span class="muted small">{o.description}</span>}</span>
          </button>
        ))}
        {(q.allowCustom !== false || !options.length) && (
          <div class={"option q-option q-custom" + (custom ? " active" : "")} onClick={() => !custom && onChange({ selected: q.multiSelect ? value.selected : [], custom: "" })}>
            <span class="q-mark">{custom ? "◉" : "○"}</span>
            {custom
              ? <input class="text-input" data-testid="form-custom" placeholder="输入你的答复" value={value.custom} autoFocus onInput={(e) => onChange({ ...value, custom: e.currentTarget.value })} />
              : <span class="muted">{options.length ? "其他（自由输入）" : "输入答复"}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function initialField(field: FormField): FieldValue {
  if (field.type === "group") return Array.from({ length: Math.max(field.min ?? 0, (field.max ?? 1) === 1 ? 1 : field.min ?? 0) }, () => initialGroup(field.fields ?? []));
  if (field.type === "checkbox") return field.default === "true" ? "true" : "false";
  return field.default ?? (field.type === "select" ? field.options?.[0] ?? "" : "");
}
function initialGroup(fields: FormField[]): FieldGroupValue { return Object.fromEntries(fields.map((f) => [f.id, initialField(f)])); }

function Field({ field, value, onChange }: { field: FormField; value: FieldValue; onChange: (v: FieldValue) => void }) {
  if (field.type === "group") {
    const groups = Array.isArray(value) ? value : [];
    const max = field.max ?? 1;
    return (
      <fieldset class="field-group" data-testid="form-group" data-field-id={field.id}>
        <legend>{field.label}</legend>
        {field.description && <div class="muted small">{field.description}</div>}
        {groups.map((group, i) => (
          <div key={i} class="field-group-item">
            {(field.fields ?? []).map((sub) => <Field key={sub.id} field={sub} value={group[sub.id] ?? initialField(sub)} onChange={(v) => onChange(groups.map((g, j) => j === i ? { ...g, [sub.id]: v } : g))} />)}
            {groups.length > (field.min ?? 0) && max !== 1 && <button type="button" class="link small" onClick={() => onChange(groups.filter((_, j) => j !== i))}>删除此组</button>}
          </div>
        ))}
        {groups.length < max && max !== 1 && <button type="button" class="btn small-btn" onClick={() => onChange([...groups, initialGroup(field.fields ?? [])])}>添加</button>}
      </fieldset>
    );
  }
  const text = typeof value === "string" ? value : "";
  const label = <>{field.label}{field.required && <span class="required">*</span>}</>;
  const common = { "data-testid": "form-field", "data-field-id": field.id };
  if (field.type === "checkbox") return <label class="check" {...common}><input type="checkbox" checked={text === "true"} onChange={(e) => onChange(e.currentTarget.checked ? "true" : "false")} /> {label}</label>;
  return (
    <label class="field" {...common}>{label}
      {field.type === "textarea" ? <textarea class="text-input" rows={4} value={text} onInput={(e) => onChange(e.currentTarget.value)} />
        : field.type === "select" ? <select class="text-input" value={text} onChange={(e) => onChange(e.currentTarget.value)}>{(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : field.type === "number" ? <input class="text-input" type="number" value={text} onInput={(e) => onChange(e.currentTarget.value)} />
        : <input class="text-input" type="text" value={text} onInput={(e) => onChange(e.currentTarget.value)} />}
      {field.description && <span class="muted small">{field.description}</span>}
    </label>
  );
}

function missingRequired(fields: FormField[], values: Record<string, FieldValue>): string | null {
  for (const f of fields) {
    const v = values[f.id];
    if (f.type === "group") {
      const groups = Array.isArray(v) ? v : [];
      if (groups.length < (f.min ?? 0)) return f.label;
      for (const g of groups) { const inner = missingRequired(f.fields ?? [], g); if (inner) return inner; }
    } else if (f.required && (typeof v !== "string" || !v.trim() || (f.type === "checkbox" && v !== "true"))) return f.label;
  }
  return null;
}

function FormBody({ form, onSubmit, onCancel, busy, error, updated, aside }: {
  form: FormSpec; onSubmit: (values: FormAnswers) => void; onCancel?: () => void; busy?: boolean; error?: string; updated?: boolean; aside: any;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [values, setValues] = useState<Record<string, FieldValue>>(() => Object.fromEntries((form.fields ?? []).map((f) => [f.id, initialField(f)])));
  const [problem, setProblem] = useState<string | null>(null);
  const questions = (form.questions ?? []).filter((q) => shown(q, answers));
  const expiry = expiresIn(form.expiresAt);
  const submit = () => {
    const unanswered = questions.find((q) => { const a = answers[q.id]; return !a || (!a.selected.length && !a.custom?.trim()); });
    if (unanswered) { setProblem(`请回答：${unanswered.header ?? unanswered.question.slice(0, 30)}`); return; }
    const missing = missingRequired(form.fields ?? [], values);
    if (missing) { setProblem(`请填写：${missing}`); return; }
    setProblem(null);
    onSubmit({
      answers: questions.map((q) => ({ id: q.id, selected: answers[q.id]?.selected ?? [], ...(answers[q.id]?.custom?.trim() ? { custom: answers[q.id]!.custom!.trim() } : {}) })),
      ...(form.fields?.length ? { fields: values } : {}),
    });
  };
  return (
    <Shell testid="form-dialog" title={form.title} aside={aside}>
      <div class="form-meta muted small">
        <span class="src-tag">{pluginName(form.source)}</span> {when(form.createdAt)}
        {expiry && <> · <span class="expiry">{expiry}</span></>}
        {form.nodeId && <> · 关联：<button class="link" onClick={() => { openForm.set(null); openNodeById(form.nodeId!); }}>{nodeTitle(form.nodeId)} ↗</button></>}
      </div>
      {updated && <div class="banner warn" data-testid="form-updated">表单已更新，请按新内容填写。</div>}
      {form.description && <Markdown text={form.description} />}
      {questions.map((q) => <Question key={q.id} q={q} value={answers[q.id] ?? { selected: [] }} onChange={(a) => setAnswers({ ...answers, [q.id]: a })} />)}
      {form.fields?.length ? <div class="form-fields">{form.fields.map((f) => <Field key={f.id} field={f} value={values[f.id] ?? initialField(f)} onChange={(v) => setValues({ ...values, [f.id]: v })} />)}</div> : null}
      {(problem || error) && <div class="error-text" data-testid="form-error">{problem ?? error}</div>}
      <div class="modal-actions form-actions">
        {form.cancel && onCancel && <button class="btn danger ghost" data-testid="form-cancel" disabled={busy} title="提交“取消”结果，插件不会当作同意" onClick={onCancel}>{form.cancel.label}</button>}
        <span class="spacer" />
        <button class="btn primary" data-testid="form-submit" disabled={busy} onClick={submit}>{busy ? "提交中…" : form.submitLabel ?? "提交"}</button>
      </div>
    </Shell>
  );
}

/** 当前打开的表单：持久表单（右上角“稍后处理”）或动作附带的表单（右上角“放弃”）。 */
export function FormDialog() {
  const open = useStore(openForm);
  const busy = useStore(formBusy);
  if (!open) return null;
  const { form } = open;
  if (!open.persistent) {
    return <FormBody key={open.key + form.revision} form={form} busy={open.submitting} error={open.error}
      aside={<button class="btn ghost later" data-testid="form-close" title="关闭弹窗，放弃这次操作" onClick={() => openForm.set(null)}>放弃</button>}
      onSubmit={(values) => { openForm.set({ ...open, submitting: true }); void open.onSubmit?.({ status: "submitted", values }); }}
      onCancel={() => void open.onSubmit?.({ status: "cancelled" })} />;
  }
  const state = busy[open.key];
  const later = <button class="btn ghost later" data-testid="form-later" title="关闭弹窗，事项留在待处理区" onClick={() => openForm.set(null)}>稍后处理</button>;
  if (state) {
    return (
      <Shell testid="form-dialog" title={form.title} aside={later}>
        <p data-testid="form-busy">{state.state === "unknown" ? "提交结果未知：请求超时或连接中断，操作可能仍在进行。" : state.message ?? "已提交，正在处理（可能在等待确认）。"}</p>
        <div class="modal-actions"><button class="btn" data-testid="form-query" onClick={() => void queryForm(form)}>查询结果</button></div>
      </Shell>
    );
  }
  const send = async (outcome: Parameters<typeof submitForm>[1]) => {
    openForm.set({ ...open, submitting: true, error: undefined });
    try {
      const close = await submitForm(form, outcome);
      const now = openForm.get();
      if (now?.key !== open.key) return;
      openForm.set(close ? null : { ...now, submitting: false });
    } catch (error) {
      const now = openForm.get();
      if (now?.key === open.key) openForm.set({ ...now, submitting: false, error: (error as Error).message });
    }
  };
  return <FormBody key={open.key + form.revision} form={form} busy={open.submitting} error={open.error} updated={open.updated} aside={later}
    onSubmit={(values) => void send({ status: "submitted", values })} onCancel={() => void send({ status: "cancelled" })} />;
}

/** 用户在场确认：一次显示一个，没有关闭按钮，只能确认或拒绝；超时由服务端裁定，这里只显示倒计时。 */
export function PresenceDialog() {
  const queue = useStore(presence);
  const request = queue[0];
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { getOrCreateDevice().then(setDevice, () => setDevice(null)); }, [request?.id]);
  useEffect(() => { setRaw(false); setBusy(false); }, [request?.id]);
  useEffect(() => { if (!request?.expiresAt) return; const timer = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(timer); }, [request?.id]);
  if (!request) return null;
  const left = request.expiresAt ? Math.max(0, Math.round((Date.parse(request.expiresAt) - Date.now()) / 1000)) : null;
  const answer = async (confirm: boolean) => { setBusy(true); await answerPresence(request, confirm); };
  return (
    <Shell testid="presence-dialog" extra="presence" title={<span class="presence-title"><span class="lock">🔐</span>需要你确认：{request.title}</span>}>
      <div class="form-meta muted small">
        <span class="src-tag">{pluginName(request.source)}</span> 发起
        {left !== null && <> · <span data-testid="presence-countdown">{left} 秒后超时，超时视为未确认</span></>}
        {queue.length > 1 && <> · 之后还有 {queue.length - 1} 项</>}
      </div>
      <Markdown text={request.summary} />
      <table class="kv presence-kv"><tbody>
        <tr><th>签名设备</th><td>{device ? <>{device.label}（本设备） · <code>{device.deviceId}</code></> : "本浏览器无法签名（不支持 WebCrypto 或 IndexedDB）"}</td></tr>
        {device && <tr><th>算法</th><td>{device.alg}</td></tr>}
      </tbody></table>
      <button class="link small" onClick={() => setRaw(!raw)}>{raw ? "▾" : "▸"} 签名内容（payload 原文）</button>
      {raw && <pre class="plain payload" data-testid="presence-payload">{JSON.stringify(request.payload, null, 2)}</pre>}
      <div class="modal-actions">
        <button class="btn" data-testid="presence-reject" disabled={busy} onClick={() => void answer(false)}>拒绝</button>
        <button class="btn primary" data-testid="presence-confirm" disabled={busy || !device} onClick={() => void answer(true)}>确认并签名</button>
      </div>
    </Shell>
  );
}

const LEVEL: Record<BannerState["level"], number> = { error: 0, warning: 1, info: 2 };

function Banner({ banner }: { banner: BannerState }) {
  useStore(plugins);
  const [open, setOpen] = useState(false);
  return (
    <div class={"g-banner lv-" + banner.level + (banner.sourceUnavailable ? " unavailable" : "")} data-testid="global-banner" data-banner-id={banner.id} data-source={banner.source}>
      <div class="g-banner-line" onClick={() => setOpen(!open)}>
        <span class="g-icon">{banner.level === "error" ? "⛔" : banner.level === "warning" ? "⚠" : "ℹ"}</span>
        <span class="g-title" data-testid="banner-title">{banner.title}</span>
        {banner.sourceUnavailable && <span class="g-unavail" data-testid="banner-unavailable">来源插件不可用，无法确认当前状态</span>}
        <span class="spacer" />
        <span class="src-tag">{pluginName(banner.source)}</span>
        {(banner.body || banner.actions?.length) ? <button class="link small">{open ? "收起" : "展开"}</button> : null}
      </div>
      {open && (
        <div class="g-banner-body">
          {banner.body && <Markdown text={banner.body} />}
          {banner.actions?.length ? <div class="row">{banner.actions.map((id) => (
            <button key={id} class="btn" data-testid="banner-action" disabled={banner.sourceUnavailable || !actionSpec(banner.source, id)}
              onClick={() => void runAction(banner.source, id, { type: "global" }, openNodeById)}>{actionSpec(banner.source, id)?.title ?? id}</button>
          ))}</div> : null}
        </div>
      )}
    </div>
  );
}

/** 页面顶部的横幅：按级别（error 在前）排列，同级保持服务端给出的顺序；用户不能关闭，只能展开或收起。 */
export function BannerStack() {
  const list = useStore(banners);
  const ref = useRef<HTMLDivElement>(null);
  const shown = list.length > 0;
  // 横幅区的高度写入 --banners-h，右上角的提示从横幅下方开始，不遮住横幅的来源标记和动作。
  useEffect(() => {
    const root = document.documentElement.style;
    const el = ref.current;
    if (!el) { root.setProperty("--banners-h", "0px"); return; }
    const observer = new ResizeObserver(() => root.setProperty("--banners-h", `${el.offsetHeight}px`));
    observer.observe(el);
    return () => { observer.disconnect(); root.setProperty("--banners-h", "0px"); };
  }, [shown]);
  if (!shown) return null;
  const sorted = list.map((b, i) => ({ b, i })).sort((x, y) => LEVEL[x.b.level] - LEVEL[y.b.level] || x.i - y.i).map((x) => x.b);
  return <div class="g-banners" data-testid="banners" ref={ref}>{sorted.map((b) => <Banner key={b.source + "\u0000" + b.id} banner={b} />)}</div>;
}

/** 通知与结果未知的动作，与普通提示同在页面右上角的提示列中。 */
export function PluginToasts() {
  const list = useStore(notifications);
  const actions = useStore(pendingActions);
  useStore(plugins);
  if (!list.length && !actions.length) return null;
  return (
    <div class="toasts plugin-toasts">
      {actions.map((a) => (
        <div key={a.key} class={"toast " + (a.state === "unknown" ? "warning" : "info")} data-testid="action-pending">
          <div class="toast-main">
            <div class="toast-title">{a.message}</div>
            <div class="toast-actions">
              <button class="btn small-btn" data-testid="action-query" onClick={() => void queryAction(a, openNodeById)}>查询结果</button>
              <span class="muted small">{pluginName(a.spec.source)}</span>
            </div>
          </div>
          <button class="icon-btn" aria-label="关闭" onClick={() => pendingActions.set((l) => l.filter((x) => x.key !== a.key))}>✕</button>
        </div>
      ))}
      {list.map((n) => (
        <div key={n.source + n.id} class={"toast " + n.level} data-testid="notification">
          <div class="toast-main">
            <div class="toast-title">{n.title}</div>
            {n.body && <Markdown text={n.body} />}
            <div class="toast-actions">
              {n.nodeId && <button class="btn small-btn" onClick={() => { dismissNotification(n.source, n.id); openNodeById(n.nodeId!); }}>打开</button>}
              {n.actions?.map((id) => actionSpec(n.source, id)).filter(Boolean).map((spec) => (
                <button key={spec!.id} class={"btn small-btn" + (spec!.danger ? " danger" : "")} onClick={() => void runAction(n.source, spec!.id, n.nodeId ? { type: "node", nodeId: n.nodeId } : { type: "global" }, openNodeById)}>{spec!.title}</button>
              ))}
              <span class="muted small">{pluginName(n.source)}</span>
            </div>
          </div>
          <button class="icon-btn" aria-label="关闭" onClick={() => dismissNotification(n.source, n.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
