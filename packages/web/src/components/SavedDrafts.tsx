// 待取回条（architecture.md“服务端暂存的清出草稿”）：输入框上方列出该会话未领取的服务端清出草稿记录，
// 每条可“放回输入框”或“放弃”。同一会话的所有标签页都显示；一页领取后，其他页收到变更通知时移除该条。
import { useEffect } from "preact/hooks";
import { isEmpty, plainText } from "../lib/draft.ts";
import { deliverRestored } from "../lib/restored.ts";
import { awaiting, claimKey, claiming, refreshSaved, savedDrafts, takeSaved, visibleSaved } from "../lib/saved-drafts.ts";
import { navigation } from "../lib/session.ts";
import { useStore } from "../lib/store.ts";
import { ask, toast } from "../lib/ui-state.ts";
import { link } from "../lib/ws.ts";
import type { PaneSavedDrafts } from "../lib/types.ts";

const SOURCE: Record<PaneSavedDrafts["reason"], string> = {
  stop: "停止时清出",
  close: "关闭会话时清出",
  shutdown: "服务端关闭前排队",
  exit: "会话停止时排队",
};

function preview(record: PaneSavedDrafts): string {
  const text = record.drafts.map((draft) => plainText(draft.nodes).replace(/\s+/g, " ").trim()).filter(Boolean).join(" / ");
  return text.length > 120 ? text.slice(0, 120) + "…" : text;
}
const images = (record: PaneSavedDrafts) => record.drafts.reduce((n, draft) => n + draft.nodes.filter((node) => node.type === "image").length, 0);
const time = (at: string) => new Date(at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function SavedDrafts({ sessionId }: { sessionId: string }) {
  const records = visibleSaved(useStore(savedDrafts), useStore(awaiting), sessionId).filter((record) => record.drafts.some((draft) => !isEmpty(draft.nodes)));
  const connected = useStore(link).state === "open";
  const busy = useStore(claiming);
  // 打开会话和每次连接建立或恢复时读取；连接期间的增删由 drafts_changed 通知。
  useEffect(() => { if (connected) void refreshSaved(sessionId); }, [sessionId, connected]);
  if (!records.length) return null;

  const take = (record: PaneSavedDrafts, discard: boolean) => takeSaved(sessionId, record, discard, {
    navigation, ask, toast,
    deliver: (id, drafts) => { deliverRestored(localStorage, id, drafts, "排队中的消息已放回输入框"); },
  });

  return (
    <div class="saved-drafts" data-testid="saved-drafts">
      {records.map((record) => {
        const count = images(record); const uncertain = record.drafts.some((draft) => draft.uncertain);
        return (
          <div key={record.id} class="composer-notice saved-draft" data-testid="saved-draft" data-record-id={record.id}>
            <span class="saved-draft-text">
              <span class="badge">{SOURCE[record.reason]}</span>
              <span class="muted">{time(record.at)}</span>{" "}
              {uncertain && <span class="badge warn" data-testid="saved-draft-uncertain">可能已发送</span>}
              {preview(record)}
              {count > 0 && <span class="muted">（{count} 张图片）</span>}
            </span>
            <button class="btn small" data-testid="saved-draft-restore" disabled={busy.has(claimKey(sessionId, record.id))} onClick={() => void take(record, false)}>放回输入框</button>
            <button class="btn small ghost" data-testid="saved-draft-discard" disabled={busy.has(claimKey(sessionId, record.id))} onClick={() => void take(record, true)}>放弃</button>
          </div>
        );
      })}
    </div>
  );
}
