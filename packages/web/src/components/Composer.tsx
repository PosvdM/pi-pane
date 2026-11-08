// 输入框（image-placeholders.md“输入框”、architecture.md“斜杠命令”“停止与控制队列”）。
// contenteditable 中的图片是 contenteditable=false 的原子节点，编号由 CSS 计数器按位置实时计算；
// 插入、删除和移动都经 execCommand 完成，撤销、重做由浏览器原生处理。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, newId } from "../lib/api.ts";
import { blobUrl } from "../lib/blobs.ts";
import { displayQueued, imageIds, isEmpty, normalize, parseSlash, plainText, prependDrafts } from "../lib/draft.ts";
import { checkImages, uploadImage } from "../lib/images.ts";
import { closeSession, control, current, editorText, restoredDrafts, stopRun, type ControlOutcome } from "../lib/session.ts";
import type { ModelState } from "../lib/session-model.ts";
import { useStore } from "../lib/store.ts";
import { ask, overlay, toast } from "../lib/ui-state.ts";
import type { DraftNode, PaneCommand, PaneControlCommand, PaneThinkingLevel } from "../lib/types.ts";
import { downloadExport, sidebarOpen } from "../lib/actions.ts";

const DRAFT_MIME = "application/x-pi-pane-draft";
const draftKey = (id: string) => `pi-pane.draft.${id}`;

export const BUILTIN: { name: string; description: string }[] = [
  { name: "compact", description: "压缩上下文，可附说明" },
  { name: "model", description: "切换模型：/model provider/model" },
  { name: "thinking", description: "设置思考级别：/thinking high" },
  { name: "new", description: "新建会话（同一进程）" },
  { name: "name", description: "设置会话名称" },
  { name: "export", description: "导出为 HTML 并下载" },
  { name: "fork", description: "从某条用户消息分叉" },
  { name: "clone", description: "复制当前会话" },
  { name: "resume", description: "打开会话列表" },
  { name: "session", description: "会话信息与用量" },
  { name: "quit", description: "关闭会话" },
];
const THINKING: PaneThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function chipHtml(assetId: string, expired = false): string {
  return `<span class="chip${expired ? " expired" : ""}" contenteditable="false" draggable="true" data-asset-id="${escapeHtml(assetId)}"></span>`;
}
function nodesHtml(nodes: DraftNode[], expired: Set<string> = new Set()): string {
  return nodes.map((n) => n.type === "image" ? chipHtml(n.assetId, expired.has(n.assetId)) : escapeHtml(n.text).replace(/\n/g, "<br>")).join("");
}

/** 从 DOM 读出草稿节点。Chrome 可能把换行写成 <br> 或块元素，两种都按换行处理。 */
export function readNodes(root: Node): DraftNode[] {
  const nodes: DraftNode[] = [];
  const walk = (node: Node, first: boolean) => {
    node.childNodes.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) nodes.push({ type: "text", text: child.textContent ?? "" });
      else if (child instanceof HTMLElement) {
        if (child.dataset.assetId) nodes.push({ type: "image", assetId: child.dataset.assetId });
        else if (child.tagName === "BR") { if (!(index === node.childNodes.length - 1 && node !== root)) nodes.push({ type: "text", text: "\n" }); }
        else if (/^(DIV|P)$/.test(child.tagName)) { if (!(first && index === 0) || nodes.length) nodes.push({ type: "text", text: "\n" }); walk(child, false); }
        else walk(child, false);
      }
    });
  };
  walk(root, true);
  const result = normalize(nodes);
  // 末尾的单个换行是 contenteditable 的占位 <br>。
  const last = result.at(-1);
  if (last?.type === "text" && last.text.endsWith("\n") && root.lastChild instanceof HTMLElement && root.lastChild.tagName === "BR") {
    const text = last.text.slice(0, -1); if (text) result[result.length - 1] = { type: "text", text }; else result.pop();
  }
  return result;
}

export function Composer({ sessionId, model, commands }: { sessionId: string; model: ModelState; commands?: PaneCommand[] }) {
  const editor = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const [uploads, setUploads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [completion, setCompletion] = useState<{ query: string; index: number } | null>(null);
  const [preview, setPreview] = useState<{ url: string; x: number; y: number } | null>(null);
  const dragged = useRef<HTMLElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restored = useStore(restoredDrafts);
  const external = useStore(editorText);
  const view = model.view;
  const phase = view.inFlight?.phase ?? "idle";
  const running = phase !== "idle" || view.status === "running";
  const blocked = view.readonlyReason === "externalWriter" ? "该会话正由其他程序托管，只能查看" : model.replaced ? "此会话的进程已切换到其他会话" : current.get()?.warning === "recentModification" ? "该会话可能正在别处运行，只能查看" : null;

  const save = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const nodes = editor.current ? readNodes(editor.current) : [];
      if (isEmpty(nodes)) localStorage.removeItem(draftKey(sessionId)); else localStorage.setItem(draftKey(sessionId), JSON.stringify(nodes));
    }, 300);
  };
  const refresh = () => {
    const nodes = editor.current ? readNodes(editor.current) : [];
    setEmpty(isEmpty(nodes));
    const slash = !nodes.some((n) => n.type === "image") ? /^\/(\S*)$/.exec(plainText(nodes)) : null;
    setCompletion(slash ? { query: slash[1], index: 0 } : null);
    save();
  };
  const setNodes = async (nodes: DraftNode[]) => {
    if (!editor.current) return;
    const ids = imageIds(nodes); let missing = new Set<string>();
    if (ids.length) {
      try { missing = new Set((await api<{ missing: string[] }>("/api/assets/touch", { requestId: newId(), assetIds: ids })).missing); }
      catch { /* 无法核对时按存在处理，发送时由服务端校验。 */ }
    }
    editor.current.innerHTML = nodesHtml(nodes, missing);
    refresh();
  };

  // 切换会话时恢复该会话保存在 localStorage 的草稿。
  useEffect(() => {
    let nodes: DraftNode[] = [];
    try { nodes = JSON.parse(localStorage.getItem(draftKey(sessionId)) ?? "[]"); } catch { /* 草稿损坏时丢弃。 */ }
    void setNodes(Array.isArray(nodes) ? nodes : []);
  }, [sessionId]);
  // 停止或关闭时清出的排队消息放回输入框，放在现有草稿之前。
  useEffect(() => {
    if (!restored || restored.sessionId !== sessionId || !editor.current) return;
    restoredDrafts.set(null);
    void setNodes(prependDrafts(restored.drafts, readNodes(editor.current)));
    toast("排队中的消息已放回输入框");
  }, [restored, sessionId]);
  useEffect(() => {
    if (!external || external.sessionId !== sessionId || !editor.current) return;
    editorText.set(null);
    void setNodes([{ type: "text", text: external.text }]);
  }, [external, sessionId]);

  const items = useMemo(() => {
    if (!completion) return [];
    const all = [...BUILTIN.map((c) => ({ ...c, source: "内置" })), ...(commands ?? []).map((c) => ({ name: c.name, description: c.description ?? "", source: c.source === "skill" ? "技能" : c.source === "prompt" ? "提示模板" : "扩展" }))];
    const q = completion.query.toLowerCase();
    return all.filter((c) => c.name.toLowerCase().startsWith(q)).concat(all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))).slice(0, 12);
  }, [completion, commands]);

  function insertHtml(html: string, range?: Range | null) {
    const el = editor.current; if (!el) return;
    el.focus();
    if (range) { const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(range); }
    else if (!el.contains(getSelection()?.anchorNode ?? null)) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); }
    document.execCommand("insertHTML", false, html);
    refresh();
  }
  async function addFiles(files: File[], range?: Range | null) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    const saved = range ?? (editor.current?.contains(getSelection()?.anchorNode ?? null) ? getSelection()!.getRangeAt(0).cloneRange() : null);
    setUploads((n) => n + images.length);
    for (const file of images) {
      try {
        const asset = await uploadImage(file);
        if (asset.note) toast(asset.note, "warning");
        insertHtml(chipHtml(asset.assetId), saved);
        saved?.collapse(false);
      } catch (error) { toast((error as Error).message, "error"); }
      finally { setUploads((n) => n - 1); }
    }
  }

  function selectedNodes(): { nodes: DraftNode[]; first: number } | null {
    const el = editor.current; const sel = getSelection();
    if (!el || !sel?.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return null;
    const box = document.createElement("div"); box.appendChild(range.cloneContents());
    let first = 1;
    el.querySelectorAll<HTMLElement>(".chip").forEach((chip) => { if (range.comparePoint(chip, 0) < 0) first++; });
    return { nodes: readNodes(box), first };
  }
  function onCopy(event: ClipboardEvent, cut = false) {
    const picked = selectedNodes(); if (!picked || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", plainText(picked.nodes, picked.first));
    event.clipboardData.setData(DRAFT_MIME, JSON.stringify(picked.nodes));
    if (cut) { document.execCommand("delete"); refresh(); }
  }
  function onPaste(event: ClipboardEvent) {
    const data = event.clipboardData; if (!data) return;
    event.preventDefault();
    const files = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) { void addFiles(files); return; }
    const internal = data.getData(DRAFT_MIME);
    if (internal) {
      try { const nodes = normalize(JSON.parse(internal)); insertHtml(nodesHtml(nodes)); return; } catch { /* 按纯文本粘贴。 */ }
    }
    const text = data.getData("text/plain");
    if (text) { document.execCommand("insertText", false, text); refresh(); }
  }
  function onDragStart(event: DragEvent) {
    const chip = (event.target as HTMLElement).closest?.(".chip") as HTMLElement | null;
    if (!chip || !event.dataTransfer) return;
    dragged.current = chip;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAFT_MIME, JSON.stringify([{ type: "image", assetId: chip.dataset.assetId }]));
    event.dataTransfer.setData("text/plain", "[Image]");
  }
  function onDragOver(event: DragEvent) {
    if (dragged.current || event.dataTransfer?.types.includes("Files")) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = dragged.current ? "move" : "copy"; }
  }
  function onDrop(event: DragEvent) {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    const files = [...(event.dataTransfer?.files ?? [])];
    const chip = dragged.current; dragged.current = null;
    if (chip) {
      event.preventDefault();
      if (!range || chip.contains(range.startContainer)) return;
      insertHtml(chipHtml(chip.dataset.assetId!, chip.classList.contains("expired")), range);
      const remove = document.createRange(); remove.selectNode(chip);
      const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(remove);
      document.execCommand("delete");
      refresh();
    } else if (files.length) { event.preventDefault(); void addFiles(files, range); }
  }
  function onMouseOver(event: MouseEvent) {
    const chip = (event.target as HTMLElement).closest?.(".chip") as HTMLElement | null;
    if (!chip?.dataset.assetId) { if (preview) setPreview(null); return; }
    const rect = chip.getBoundingClientRect();
    void blobUrl(`/api/assets/${chip.dataset.assetId}/thumb`).then((url) => setPreview({ url, x: rect.left, y: rect.top }), () => {});
  }

  function choose(name: string) {
    const el = editor.current; if (!el) return;
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    document.execCommand("insertText", false, `/${name} `);
    setCompletion(null); save();
  }

  async function runCommand(command: PaneControlCommand, okText?: string): Promise<ControlOutcome> {
    const outcome = await control(command);
    if (!outcome.ok) toast(outcome.error.code === "revisionChanged" ? "会话状态已变化，请确认后重新执行命令" : outcome.error.message, outcome.error.code === "revisionChanged" ? "warning" : "error");
    else if (outcome.result.status === "accepted" && outcome.result.result?.cancelled) toast("操作被扩展取消", "warning");
    else if (okText) toast(okText);
    return outcome;
  }

  /** 处理斜杠命令；返回 true 表示已处理，不再作为消息发送。 */
  async function slash(name: string, args: string): Promise<boolean> {
    switch (name) {
      case "compact": await runCommand({ type: "compact", ...(args ? { customInstructions: args } : {}) }, "已压缩"); return true;
      case "model": {
        if (!args) { overlay.set("models"); return true; }
        const at = args.indexOf("/");
        if (at <= 0) { toast("格式：/model provider/model", "warning"); return true; }
        await runCommand({ type: "set_model", provider: args.slice(0, at), modelId: args.slice(at + 1) }, "已切换模型"); return true;
      }
      case "thinking":
        if (!args) { overlay.set("thinking"); return true; }
        if (!THINKING.includes(args as PaneThinkingLevel)) { toast(`思考级别只能是 ${THINKING.join("、")}`, "warning"); return true; }
        await runCommand({ type: "set_thinking_level", level: args as PaneThinkingLevel }, "已设置思考级别"); return true;
      case "new": await runCommand({ type: "new_session" }); return true;
      case "name":
        if (!args) { toast(`当前名称：${view.state?.sessionName ?? "（未设置）"}`); return true; }
        await runCommand({ type: "set_session_name", name: args }, "已设置会话名称"); return true;
      case "export": {
        const outcome = await runCommand({ type: "export" });
        if (outcome.ok && outcome.result.status === "accepted" && outcome.result.result?.exportId) await downloadExport(outcome.result.result.exportId);
        return true;
      }
      case "fork": overlay.set("fork"); return true;
      case "clone": await runCommand({ type: "clone" }); return true;
      case "resume": sidebarOpen.set(true); return true;
      case "session": overlay.set("session-info"); return true;
      case "quit": await closeSession(); return true;
    }
    if (!view.hosted || commands?.some((c) => c.name === name)) return false;
    toast(`pi-pane 不支持 /${name}，请在终端中使用 pi`, "warning");
    return true;
  }

  async function send(delivery?: "steer" | "follow_up") {
    const el = editor.current; if (!el || busy || blocked) return;
    const nodes = readNodes(el);
    if (isEmpty(nodes)) return;
    setCompletion(null);
    const command = parseSlash(nodes);
    if (command) {
      setBusy(true);
      try { if (await slash(command.name, command.args)) { el.innerHTML = ""; refresh(); return; } }
      finally { setBusy(false); }
    }
    if (el.querySelector(".chip.expired")) { toast("图片已过期，请重新添加", "warning"); return; }
    if (uploads) { toast("图片仍在上传", "warning"); return; }
    const ids = imageIds(nodes);
    const problem = checkImages(ids); if (problem) { toast(problem, "warning"); return; }
    if (ids.length && view.state?.model && !view.state.model.images) { toast("当前模型不支持图片，请切换模型", "warning"); return; }
    let type: "prompt" | "steer" | "follow_up" = running ? delivery ?? "steer" : "prompt";
    setBusy(true);
    try {
      for (;;) {
        const outcome = await control({ type }, nodes);
        if (outcome.ok) {
          if (el.isConnected && JSON.stringify(readNodes(el)) === JSON.stringify(nodes)) { el.innerHTML = ""; refresh(); }
          if (outcome.result.status === "accepted" && outcome.result.result?.handled) toast("消息已由扩展处理");
          return;
        }
        if (outcome.error.code !== "revisionChanged") { toast(outcome.error.message, "error"); return; }
        // 用户看到的状态已过期：按最新状态请用户重新确认，草稿保留，不自动重发。
        const latest = current.get()?.model?.view;
        const nowRunning = (latest?.inFlight?.phase ?? "idle") !== "idle";
        if (latest?.inFlight?.phase === "stopping") { toast("会话正在停止，请稍后再发送", "warning"); return; }
        const answer = nowRunning
          ? await ask("会话已开始运行", "另一个标签页刚刚改变了会话状态。这条消息怎么发送？", [{ label: "取消", value: "cancel" }, { label: "排队（follow-up）", value: "follow_up" }, { label: "追加（steer）", value: "steer", primary: true }])
          : await ask("会话已停下", "另一个标签页刚刚改变了会话状态。是否作为新消息发送？", [{ label: "取消", value: "cancel" }, { label: "发送", value: "prompt", primary: true }]);
        if (!answer || answer === "cancel") return;
        type = answer as typeof type;
      }
    } finally { setBusy(false); }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (completion && items.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setCompletion({ ...completion, index: (completion.index + 1) % items.length }); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setCompletion({ ...completion, index: (completion.index - 1 + items.length) % items.length }); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && items[completion.index]?.name !== completion.query)) { event.preventDefault(); choose(items[completion.index].name); return; }
      if (event.key === "Escape") { event.preventDefault(); setCompletion(null); return; }
    }
    if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); document.execCommand("insertLineBreak"); refresh(); return; }
    if (event.key === "Enter") { event.preventDefault(); void send(event.altKey ? "follow_up" : "steer"); }
  }

  const queue = view.inFlight?.queue;
  const queued = [...(queue?.steering ?? []).map((t) => ({ t, kind: "追加" })), ...(queue?.followUp ?? []).map((t) => ({ t, kind: "排队" }))];
  return (
    <div class="composer-wrap">
      {queued.length > 0 && (
        <div class="queue" data-testid="queue">
          {queued.map((q, i) => <div key={i} class="queued"><span class="badge">{q.kind}</span>{displayQueued(q.t)}</div>)}
        </div>
      )}
      {completion && items.length > 0 && (
        <div class="completion" data-testid="completion" role="listbox">
          {items.map((item, i) => (
            <div key={item.name} role="option" aria-selected={i === completion.index} class={"completion-item" + (i === completion.index ? " active" : "")} onMouseDown={(e) => { e.preventDefault(); choose(item.name); }}>
              <span class="cmd">/{item.name}</span><span class="desc">{item.description}</span><span class="src">{item.source}</span>
            </div>
          ))}
        </div>
      )}
      {blocked && <div class="composer-blocked">{blocked}</div>}
      <div class="composer">
        <div
          ref={editor}
          class={"editor" + (empty ? " empty" : "")}
          contentEditable={blocked ? "false" : "true"}
          role="textbox"
          aria-multiline="true"
          aria-label="消息输入框"
          data-testid="composer"
          data-placeholder={running ? "Enter 追加（steer），Alt+Enter 排队（follow-up）" : "输入消息，Enter 发送，Shift+Enter 换行，/ 查看命令"}
          onInput={refresh}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCopy={(e) => onCopy(e)}
          onCut={(e) => onCopy(e, true)}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={() => { dragged.current = null; }}
          onMouseOver={onMouseOver}
          onMouseLeave={() => setPreview(null)}
          onBlur={() => setTimeout(() => setCompletion(null), 150)}
        />
        <div class="composer-actions">
          <label class="btn ghost" title="添加图片">
            添加图片
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden data-testid="image-input" onChange={(e) => { const input = e.currentTarget; void addFiles([...(input.files ?? [])]); input.value = ""; }} />
          </label>
          {uploads > 0 && <span class="muted">上传中 {uploads}</span>}
          <span class="spacer" />
          {running && <button class="btn danger" data-testid="stop" onClick={() => void stopRun()} disabled={phase === "stopping"}>{phase === "stopping" ? "正在停止" : "停止"}</button>}
          {running ? (
            <>
              <button class="btn" data-testid="follow-up" disabled={empty || busy || !!blocked} onClick={() => void send("follow_up")}>排队</button>
              <button class="btn primary" data-testid="steer" disabled={empty || busy || !!blocked} onClick={() => void send("steer")}>追加</button>
            </>
          ) : (
            <button class="btn primary" data-testid="send" disabled={empty || busy || !!blocked} onClick={() => void send()}>发送</button>
          )}
        </div>
      </div>
      {preview && <img class="chip-preview" src={preview.url} alt="缩略图" style={{ left: `${preview.x}px`, top: `${preview.y - 8}px` }} />}
    </div>
  );
}

