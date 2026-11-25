// 前端使用的类型：pane 协议（plugin-api）与浏览器接口（server/web-api.ts）。只引用类型，不打包服务端代码。
export type * from "../../../server/src/web-api.ts";
export type {
  ActionResult, ActionSpec, ActionTarget, BannerState, CustomMessageRenderer, DraftNode, FieldValue, FormAnswers, FormField, FormOutcome,
  FormQuestion, FormSpec, FormSubmitResult, InFlightBlock, InFlightState, ListItem, NodeStatus, PaneNotification, PanelContent, PanelSpec,
  PanelUpdate, SessionRef, SessionSnapshot, SessionStreamEvent, StreamCursor, TableRow, TreeChange, TreeChildrenPage, TreeCursor, TreeNode,
  TreeSnapshot, UnfinishedPartial, AbortResult, SendResult,
} from "@pi-pane/plugin-api";
