// 打开会话树节点：主会话按文件打开，插件节点打开插件视图。侧栏、面板、通知和工具卡片链接共用。
import { closePluginView, openPluginNode, pluginView } from "./plugin-session.ts";
import { current, detach, openFile } from "./session.ts";
import { findNode, loadTree, pinNode, trees } from "./tree.ts";
import { toast } from "./ui-state.ts";
import type { PaneSessionNodeInfo, TreeNode } from "./types.ts";

export type PaneTreeNode = TreeNode & { paneSession?: PaneSessionNodeInfo };

/** 节点的显示名称：没有名称、也没有首条用户文本的主会话显示“（空会话）”，不显示会话 ID。 */
export function nodeLabel(node: TreeNode): string {
  return (node as PaneTreeNode).paneSession?.untitled ? "（空会话）" : node.title;
}

export function openNode(node: TreeNode): void {
  const info = (node as PaneTreeNode).paneSession;
  if (node.source === "pane") {
    if (node.kind !== "session" || !info) return;
    closePluginView(); void openFile(info.cwd, info.sessionFile);
    return;
  }
  // 打开插件节点也是一次导航：主会话的导航代次随之失效，旧会话迟到的切换结果（/new 等）和替换事件不再把视图拉回主会话。
  detach();
  void openPluginNode(node);
}

let waiting: (() => void) | null = null;

/**
 * 按 id 打开。节点还不在已加载的树里时（如动作刚创建的节点，树变更晚于动作结果到达），
 * 把它加入该来源快照的打开列表并重取，等节点出现后再打开；10 秒内没有出现，或期间用户已切换视图，则放弃。
 */
export function openNodeById(id: string): void {
  waiting?.(); waiting = null;
  const node = findNode(id);
  if (node) { openNode(node); return; }
  const source = id.slice(0, id.indexOf(":"));
  if (!source) { toast("该节点不在会话列表中", "warning"); return; }
  pinNode(source, id); void loadTree(source);
  const view = pluginView.get(); const main = current.get();
  const stop = () => { clearTimeout(timer); off(); if (waiting === stop) waiting = null; };
  const off = trees.subscribe(() => {
    if (pluginView.get() !== view || current.get() !== main) { stop(); return; }
    const found = findNode(id);
    if (found) { stop(); openNode(found); }
  });
  const timer = setTimeout(() => { stop(); toast("该节点不在会话列表中，可能已被删除", "warning"); }, 10000);
  waiting = stop;
}
