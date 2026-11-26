// 输入框草稿的挂载流程，主会话输入框（Composer.tsx）和插件会话输入框（PluginSession.tsx）共用（architecture.md“取回草稿的交付”）：
// 挂载或切换会话时读出本标签页的草稿，登记为该会话的放回目标并取走待放回记录，取回无人等待的在途提交，收养已关闭标签页的草稿；
// 编辑延迟写入，页面隐藏、关闭或刷新、卸载时立即写入。存储与判断都在 restored.ts。
import { useLayoutEffect, useRef } from "preact/hooks";
import { prependDrafts } from "../lib/draft.ts";
import { ADOPT_SETTLE_MS, addNotice, adoptDrafts, attachComposer, batchPrefix, clearNotice, draftPrefix, loadDraft, loadNotice, noticeChanged, noticeKey, recoverFlights, saveDraft, takePending, unsavedSessions, watchOwner } from "../lib/restored.ts";
import { useStore } from "../lib/store.ts";
import { ownTab, TAB_ID } from "../lib/tab.ts";
import { toast } from "../lib/ui-state.ts";
import type { DraftNode } from "../lib/types.ts";

/** 输入框本身：读出内容、替换内容。 */
export interface DraftSurface {
  read(): DraftNode[];
  /** 替换内容，不移动光标（放回草稿）。 */
  set(nodes: DraftNode[]): void;
  /** 显示与草稿存储一致的内容（挂载时读出、收养），焦点在输入框中时光标移到末尾。 */
  show(nodes: DraftNode[]): void;
}

export interface ComposerDrafts {
  /** 用户编辑后调用：记下内容，延迟 300 毫秒写入。 */
  changed(nodes: DraftNode[]): void;
  /** 立即写入尚未保存的编辑。 */
  flush(): void;
}

export function useComposerDrafts(sessionId: string, surface: DraftSurface): ComposerDrafts {
  const current = useRef(surface); current.current = surface;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 待写入 localStorage 的草稿：编辑时立即捕获内容，延迟写入；切换会话、卸载、页面隐藏和关闭或刷新时同步写入。
  // 草稿存储按标签页分键，只由本页写入。
  const pendingSave = useRef<{ sessionId: string; nodes: DraftNode[] } | null>(null);
  const flush = () => {
    clearTimeout(saveTimer.current);
    const pending = pendingSave.current; pendingSave.current = null;
    if (pending) saveDraft(localStorage, pending.sessionId, ownTab(), pending.nodes);
  };
  const changed = (nodes: DraftNode[]) => {
    pendingSave.current = { sessionId, nodes };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 300);
  };
  /** 显示与本页草稿存储一致的内容，不安排保存。 */
  const show = (nodes: DraftNode[]) => {
    current.current.show(nodes);
    clearTimeout(saveTimer.current); pendingSave.current = null;
  };

  // 切换会话时恢复该会话保存的草稿，再放回停止、关闭或提交失败时取回、尚未放回的草稿；离开时先写入尚未保存的编辑。
  // 用 layout effect 在浏览器绘制和用户输入之前完成恢复，避免覆盖挂载后立即输入的内容。
  useLayoutEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    show(loadDraft(localStorage, sessionId, ownTab()));
    const detach = attachComposer(sessionId, {
      // 取回的草稿放在现有草稿之前，并立即保存，之后才删除待放回记录。
      deliver: (drafts, message) => {
        const merged = prependDrafts(drafts.map((draft) => draft.nodes), current.current.read());
        current.current.set(merged);
        pendingSave.current = { sessionId, nodes: merged }; flush();
        const uncertain = drafts.filter((draft) => draft.uncertain).length;
        if (uncertain) addNotice(localStorage, sessionId, uncertain);
        if (message) toast(message, uncertain ? "warning" : undefined);
      },
    });
    // 同一会话可能在多个标签页挂载：用 Web Lock 串行取走待放回记录，避免同一批放回两次。
    const take = () => {
      const run = () => { takePending(localStorage, sessionId); };
      if (navigator.locks) void navigator.locks.request(batchPrefix(sessionId), run); else run();
    };
    // 已无页面等待结果的在途提交（提交后刷新或关闭了页面）按结果无法确认放回。
    const recover = () => {
      void recoverFlights(localStorage, sessionId).then((wait) => { if (alive && wait !== null) timer = setTimeout(recover, wait + 50); });
    };
    // 收养本会话中已关闭标签页的草稿：放在本页现有内容之前，先写入本页的键，之后才删除原键。
    // 仍开着的标签页在它的锁上排队等待（watchOwner），它关闭后稍等再收养一次，前台页关闭、本页接替时也能及时收养。
    const watching = new Set<string>(); const stop = new AbortController(); const settles = new Set<ReturnType<typeof setTimeout>>();
    const watch = (owner: string) => {
      if (!navigator.locks || watching.has(owner) || stop.signal.aborted) return;
      watching.add(owner);
      watchOwner(navigator.locks, owner, stop.signal, () => {
        watching.delete(owner);
        const settle = setTimeout(() => { settles.delete(settle); adopt(); }, ADOPT_SETTLE_MS); settles.add(settle);
      });
    };
    const adopt = () => {
      void adoptDrafts(localStorage, sessionId, ownTab(), (nodes, legacy) => {
        if (!alive) return undefined;
        const merged = prependDrafts([nodes], current.current.read());
        show(merged);
        if (!legacy) toast("已关闭的标签页中这个会话的草稿已放入输入框");
        return saveDraft(localStorage, sessionId, ownTab(), merged);
      }).then((held) => { if (alive) held.forEach(watch); });
    };
    take(); recover(); adopt();
    const onVisible = () => { if (document.visibilityState === "visible") adopt(); else flush(); };
    document.addEventListener("visibilitychange", onVisible);
    // 刷新、关闭或离开页面不触发卸载：立即写入防抖期间的编辑。
    addEventListener("pagehide", flush);
    // 其他标签页存入的待放回草稿、对提示的修改，以及其他标签页新写的草稿键（等它关闭后收养）。另一标签页的草稿本页不读取、不同步。
    const prefix = draftPrefix(sessionId);
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(batchPrefix(sessionId)) && event.newValue) take();
      if (event.key === noticeKey(sessionId)) noticeChanged.set((n) => n + 1);
      const owner = event.key?.startsWith(prefix) ? event.key.slice(prefix.length) : "";
      if (event.newValue && TAB_ID.test(owner) && owner !== ownTab()) watch(owner);
    };
    addEventListener("storage", onStorage);
    return () => {
      alive = false; clearTimeout(timer); stop.abort(); settles.forEach(clearTimeout);
      removeEventListener("storage", onStorage); removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVisible);
      detach(); flush();
    };
  }, [sessionId]);

  return { changed, flush };
}

/**
 * 输入框上方与草稿有关的提示：浏览器存储写满时草稿只保存在页面内存中；取回的草稿中有归属不明（无法确认是否已经发送）的条目。
 * 归属不明的提示按会话保存，用户点“知道了”、清空输入框或该会话有一条消息送达后移除。
 */
export function DraftNotices({ sessionId }: { sessionId: string }) {
  const unsaved = useStore(unsavedSessions).has(sessionId);
  useStore(noticeChanged);
  const notice = loadNotice(localStorage, sessionId)?.count ?? 0;
  return (
    <>
      {unsaved && <div class="composer-notice error" data-testid="unsaved-notice" role="alert">浏览器存储空间不足，这个会话的草稿只保存到页面关闭前。请先发送或复制草稿，或清理浏览器存储。</div>}
      {notice > 0 && (
        <div class="composer-notice warn" data-testid="restored-notice">
          <span>取回的草稿中有 {notice} 条无法确认是否已经发送，请检查后再决定是否重发。</span>
          <button class="btn ghost" data-testid="restored-notice-dismiss" onClick={() => clearNotice(localStorage, sessionId)}>知道了</button>
        </div>
      )}
    </>
  );
}
