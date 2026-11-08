// 弹窗：pi 扩展 UI 对话框、项目信任询问、应用内确认、提示消息。
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, newId } from "../lib/api.ts";
import { current } from "../lib/session.ts";
import { useStore } from "../lib/store.ts";
import { trustChanged } from "../lib/events.ts";
import { choice, dismissToast, extensionUi, toast, toasts, trustRequests, type DialogRequest } from "../lib/ui-state.ts";
import type { PaneUiAnswerResult } from "../lib/types.ts";

export function Modal({ title, children, onClose, testid, wide }: { title: string; children: any; onClose?: () => void; testid?: string; wide?: boolean }) {
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div class="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class={"modal" + (wide ? " wide" : "")} role="dialog" aria-label={title} data-testid={testid}>
        <div class="modal-head"><span>{title}</span>{onClose && <button class="icon-btn" aria-label="关闭" onClick={onClose}>✕</button>}</div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

function useCountdown(expiresAt?: string): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : null;
}

const attempts = new Map<string, string>();

function removeDialog(sessionId: string, id: string): void {
  extensionUi.set((all) => all[sessionId] ? { ...all, [sessionId]: { ...all[sessionId], dialogs: all[sessionId].dialogs.filter((d) => d.id !== id) } } : all);
}

/** pi 扩展的 select、confirm、input、editor 对话框。 */
export function ExtensionDialog() {
  const state = useStore(current);
  const all = useStore(extensionUi);
  const id = state?.id ?? "";
  const request: DialogRequest | undefined = all[id]?.dialogs[0];
  // 输入值按对话框 id 归属：新对话框直接使用初始值，不经 effect 重置，用户立即输入的内容不会被覆盖。
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null);
  const value = edit && edit.id === request?.id ? edit.value : request?.kind === "editor" ? request.prefill ?? "" : "";
  const setValue = (next: string) => { if (request) setEdit({ id: request.id, value: next }); };
  const [sending, setSending] = useState(false);
  const left = useCountdown(request?.expiresAt);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { setTimeout(() => input.current?.focus(), 0); }, [request?.id]);
  useEffect(() => { if (request && left === 0) removeDialog(id, request.id); }, [left]);
  if (!request || !state?.model) return null;

  async function answer(body?: { value: string } | { confirmed: boolean }) {
    if (!request || sending) return;
    setSending(true);
    // 同一个答案的重试沿用同一 requestId，由服务端去重。
    const key = request.id + JSON.stringify(body ?? null);
    const requestId = attempts.get(key) ?? newId(); attempts.set(key, requestId);
    let done = false;
    try {
      const result = await api<PaneUiAnswerResult>(`/api/sessions/${encodeURIComponent(id)}/ui`, { requestId, expectedEpoch: current.get()?.model?.view.cursor.epoch, id: request.id, ...(body ? { answer: body } : {}) });
      if (result.status === "alreadyHandled") toast("该对话框已在别处处理或已超时");
      done = true;
    } catch (error) {
      const epoch = error instanceof ApiError && error.code === "epochChanged";
      done = epoch;
      toast(epoch ? "会话进程已更换，对话框已失效" : `回应未送达：${(error as Error).message}，可以重试`, "warning");
    } finally {
      setSending(false);
      if (done) { attempts.delete(key); removeDialog(id, request.id); }
    }
  }
  const cancel = () => void answer();
  return (
    <Modal title={request.title || "扩展请求"} onClose={cancel} testid="ui-dialog">
      <div class="muted small">来自 pi 扩展{left !== null ? ` · ${left} 秒后按默认值处理` : ""}</div>
      {request.kind === "confirm" && (
        <>
          {request.message && <p class="plain-text">{request.message}</p>}
          <div class="modal-actions">
            <button class="btn" onClick={() => void answer({ confirmed: false })} disabled={sending}>否</button>
            <button class="btn primary" data-testid="ui-confirm" onClick={() => void answer({ confirmed: true })} disabled={sending}>是</button>
          </div>
        </>
      )}
      {request.kind === "select" && (
        <div class="options">
          {request.options.map((option) => <button key={option} class="option" data-testid="ui-option" onClick={() => void answer({ value: option })} disabled={sending}>{option}</button>)}
        </div>
      )}
      {(request.kind === "input" || request.kind === "editor") && (
        <form onSubmit={(e) => { e.preventDefault(); void answer({ value }); }}>
          {request.kind === "input"
            ? <input ref={input} class="text-input" data-testid="ui-input" placeholder={request.placeholder ?? ""} value={value} onInput={(e) => setValue(e.currentTarget.value)} />
            : <textarea ref={input} class="text-input tall" data-testid="ui-input" value={value} onInput={(e) => setValue(e.currentTarget.value)} />}
          <div class="modal-actions">
            <button type="button" class="btn" onClick={cancel} disabled={sending}>取消</button>
            <button type="submit" class="btn primary" data-testid="ui-submit" disabled={sending}>确定</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** 拉起 pi 之前的项目信任询问（architecture.md“项目信任”）。 */
export function TrustDialog() {
  const requests = useStore(trustRequests);
  const request = requests[0];
  const [remember, setRemember] = useState(false);
  const left = useCountdown(request?.expiresAt);
  useEffect(() => { if (request && left === 0) (trustChanged(), trustRequests.set((list) => list.filter((r) => r.id !== request.id))); }, [left]);
  if (!request) return null;
  async function decide(trusted?: boolean) {
    const body = trusted === undefined ? {} : { decision: { trusted, remember } };
    const key = request.id + JSON.stringify(body);
    const requestId = attempts.get(key) ?? newId(); attempts.set(key, requestId);
    try {
      await api(`/api/trust/${encodeURIComponent(request.id)}`, { requestId, ...body });
      attempts.delete(key); (trustChanged(), trustRequests.set((list) => list.filter((r) => r.id !== request.id)));
    } catch (error) {
      // 询问已处理或过期时关闭；其他失败保留询问以便重试。
      if (error instanceof ApiError && error.code === "trustExpired") { attempts.delete(key); (trustChanged(), trustRequests.set((list) => list.filter((r) => r.id !== request.id))); }
      else toast(`回答未送达：${(error as Error).message}，可以重试`, "warning");
    }
  }
  return (
    <Modal title="项目信任" onClose={() => void decide()} testid="trust-dialog">
      <p>是否信任项目 <code>{request.cwd}</code>？</p>
      <p class="muted small">信任只决定是否加载项目的设置和资源（扩展、技能、MCP 等）。AGENTS.md 等上下文文件不受信任设置影响，始终加载。{left !== null ? ` ${left} 秒后视为未作答。` : ""}</p>
      <label class="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} /> 记住此选择</label>
      <div class="modal-actions">
        <button class="btn" data-testid="trust-no" onClick={() => void decide(false)}>不信任</button>
        <button class="btn primary" data-testid="trust-yes" onClick={() => void decide(true)}>信任</button>
      </div>
    </Modal>
  );
}

export function ChoiceView() {
  const dialog = useStore(choice);
  if (!dialog) return null;
  return (
    <Modal title={dialog.title} onClose={() => dialog.resolve(null)} testid="choice-dialog">
      <p class="plain-text">{dialog.message}</p>
      <div class="modal-actions">
        {dialog.choices.map((c) => <button key={c.value} class={"btn" + (c.primary ? " primary" : "") + (c.danger ? " danger" : "")} data-choice={c.value} onClick={() => dialog.resolve(c.value)}>{c.label}</button>)}
      </div>
    </Modal>
  );
}

export function Toasts() {
  const list = useStore(toasts);
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={"toast " + t.level} data-testid="toast">
          <span class="plain-text">{t.text}</span>
          <button class="icon-btn" aria-label="关闭" onClick={() => dismissToast(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
