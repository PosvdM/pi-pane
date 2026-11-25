// 打开会话树节点：主会话按文件打开，插件节点打开插件视图。侧栏、面板、通知和工具卡片链接共用。
import { closePluginView, openPluginNode } from "./plugin-session.ts";
import { openFile } from "./session.ts";
import { findNode } from "./tree.ts";
import { toast } from "./ui-state.ts";
import type { PaneSessionNodeInfo, TreeNode } from "./types.ts";

export type PaneTreeNode = TreeNode & { paneSession?: PaneSessionNodeInfo };

export function openNode(node: TreeNode): void {
  const info = (node as PaneTreeNode).paneSession;
  if (node.source === "pane") {
    if (node.kind !== "session" || !info) return;
    closePluginView(); void openFile(info.cwd, info.sessionFile);
    return;
  }
  void openPluginNode(node);
}

/** 按 id 打开；节点不在已加载的树里时提示，不猜测来源。 */
export function openNodeById(id: string): void {
  const node = findNode(id);
  if (node) openNode(node); else toast("该节点不在会话列表中，可能已被删除或尚未加载", "warning");
}
