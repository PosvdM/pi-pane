// 会话事件之外的 WebSocket 消息：扩展 UI 请求与项目信任询问。
import { editorText } from "./session.ts";
import { emptyUi, extensionUi, toast, trustRequests, type DialogRequest } from "./ui-state.ts";
import * as ws from "./ws.ts";
import { api } from "./api.ts";
import type { PaneTrustRequest } from "./types.ts";

let editorSeq = 0;

function update(id: string, change: (ui: ReturnType<typeof emptyUi>) => void): void {
  extensionUi.set((all) => {
    const ui = all[id] ? { dialogs: [...all[id].dialogs], statuses: { ...all[id].statuses }, widgets: { ...all[id].widgets } } : emptyUi();
    change(ui);
    return { ...all, [id]: ui };
  });
}

export function installEventHandlers(): void {
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
      trustRequests.set((list) => list.some((r) => r.id === message.request.id) ? list : [...list, message.request]);
    } else if (message.type === "project_trust_resolved") {
      trustRequests.set((list) => list.filter((r) => r.id !== message.id));
    } else if (message.type === "banners") {
      // 重连后补取连接断开期间发出的信任询问。
      void api<{ requests: PaneTrustRequest[] }>("/api/trust").then(({ requests }) => trustRequests.set(requests)).catch(() => {});
    }
  });
}
