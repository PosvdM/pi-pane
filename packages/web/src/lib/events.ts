// 会话事件之外的 WebSocket 消息：扩展 UI 请求与项目信任询问。
import { editorText } from "./session.ts";
import { emptyUi, extensionUi, toast, trustRequests, type DialogRequest } from "./ui-state.ts";
import * as ws from "./ws.ts";
import { api } from "./api.ts";
import type { PaneTrustRequest } from "./types.ts";

let editorSeq = 0;
/** 信任询问列表的实时变更次数：HTTP 快照与 WebSocket 推送没有共同顺序，快照请求期间有推送时重新获取。 */
let trustVersion = 0;
/** 同步代次：只有最后一次发起的快照请求可以提交，跨重连晚到的旧快照被丢弃。 */
let trustSync = 0;
/** 本地删除（回答、超时）也计入变更，避免同期快照让已处理的询问复活。 */
export function trustChanged(): void { trustVersion++; }
function syncTrust(): void {
  const version = trustVersion; const seq = ++trustSync;
  void api<{ requests: PaneTrustRequest[] }>("/api/trust").then(({ requests }) => {
    if (seq !== trustSync) return;
    if (version === trustVersion) trustRequests.set(requests); else syncTrust();
  }).catch(() => {});
}

function update(id: string, change: (ui: ReturnType<typeof emptyUi>) => void): void {
  extensionUi.set((all) => {
    const ui = all[id] ? { dialogs: [...all[id].dialogs], statuses: { ...all[id].statuses }, widgets: { ...all[id].widgets } } : emptyUi();
    change(ui);
    return { ...all, [id]: ui };
  });
}

export function installEventHandlers(): void {
  // 待答对话框以服务端为准：离线或退订期间可能已在别处处理，重新订阅时清空后由服务端重发。
  ws.onSubscribing((id) => update(id, (ui) => { ui.dialogs = []; }));
  ws.onMessage((message) => {
    if (message.type === "ui_request") {
      const id = message.ref.id; const request = message.request;
      switch (request.kind) {
        case "select": case "confirm": case "input": case "editor":
          update(id, (ui) => { if (!ui.dialogs.some((d) => d.id === request.id)) ui.dialogs.push(request as DialogRequest); });
          break;
        case "notify": toast(request.message, request.level); break;
        case "status": update(id, (ui) => { if (request.text) ui.statuses[request.key] = request.text; else delete ui.statuses[request.key]; }); break;
        case "widget": update(id, (ui) => { if (request.lines?.length) ui.widgets[request.key] = { lines: request.lines, placement: request.placement }; else delete ui.widgets[request.key]; }); break;
        case "title": document.title = request.title ? `${request.title} · pi-pane` : "pi-pane"; break;
        case "editorText": editorText.set({ sessionId: id, text: request.text, seq: ++editorSeq }); break;
      }
    } else if (message.type === "ui_resolved") {
      update(message.ref.id, (ui) => { ui.dialogs = ui.dialogs.filter((d) => d.id !== message.id); });
    } else if (message.type === "project_trust") {
      trustVersion++;
      trustRequests.set((list) => list.some((r) => r.id === message.request.id) ? list : [...list, message.request]);
    } else if (message.type === "project_trust_resolved") {
      trustVersion++;
      trustRequests.set((list) => list.filter((r) => r.id !== message.id));
    } else if (message.type === "banners") {
      // 重连后补取连接断开期间发出的信任询问。
      syncTrust();
    }
  });
}
