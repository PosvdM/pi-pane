import type { DraftNode } from "@pi-pane/plugin-api";

// pi 主会话适配器使用的 RPC 信封，不属于通用插件契约。
export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown }
export interface ControlRequest { requestId: string; expectedEpoch: string; expectedRevision: number; command: { type: string; [key: string]: unknown }; draft?: DraftNode[] }
