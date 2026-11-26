// 打开会话树节点：主会话按文件打开，插件节点打开插件视图。侧栏、面板、通知和工具卡片链接共用。
import { closePluginView, openPluginNode } from "./plugin-session.ts";
import { detach, navigation, openFile } from "./session.ts";
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
 * since 为发起时的导航代次（见 openFromResult），省略时取调用时的代次；代次变化即用户已切换视图。
 */
export function openNodeById(id: string, since = navigation()): void {
  waiting?.(); waiting = null;
  if (navigation() !== since) return;
  const node = findNode(id);
  if (node) { openNode(node); return; }
  const source = id.slice(0, id.indexOf(":"));
  if (!source) { toast("该节点不在会话列表中", "warning"); return; }
  pinNode(source, id); void loadTree(source);
  const stop = () => { clearTimeout(timer); off(); if (waiting === stop) waiting = null; };
  const off = trees.subscribe(() => {
    if (navigation() !== since) { stop(); return; }
    const found = findNode(id);
    if (found) { stop(); openNode(found); }
  });
  const timer = setTimeout(() => { stop(); toast("该节点不在会话列表中，可能已被删除", "warning"); }, 10000);
  waiting = stop;
}

/**
 * 动作结果里的 openNodeId 用的打开函数，在发起动作时调用以记下导航代次。结果返回前用户已切换到其他会话或节点时不跳转，
 * 只提示，旧操作的结果不覆盖用户之后的选择（development.md“旧请求不能覆盖新选择”）。
 */
export function openFromResult(): (nodeId: string) => void {
  const since = navigation();
  return (id) => {
    if (navigation() === since) { openNodeById(id, since); return; }
    const node = findNode(id);
    toast(`操作已完成，结果${node ? "“" + nodeLabel(node) + "”" : "节点"}可在会话列表中打开`);
  };
}
