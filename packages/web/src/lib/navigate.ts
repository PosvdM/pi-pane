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
 * 选择代次：导航代次（session.ts 的 navigation，打开主会话、打开插件节点时加一）加上用户经 openNodeById 发起的选择次数。
 * 用户点击还不在树里的节点时只登记等待、视图不变，导航代次不变，但这同样是用户新的选择：旧动作的结果不能取消这次等待。
 */
interface Pick { nav: number; pick: number }
let picks = 0;
const pickNow = (): Pick => ({ nav: navigation(), pick: picks });
const samePick = (since: Pick) => since.nav === navigation() && since.pick === picks;

/**
 * 按 id 打开。节点还不在已加载的树里时（如动作刚创建的节点，树变更晚于动作结果到达），
 * 把它加入该来源快照的打开列表并重取，等节点出现后再打开；10 秒内没有出现，或期间用户已作出其他选择，则放弃。
 * 用户发起时省略 since，选择代次随之推进；动作结果的打开（openFromResult）传入发起动作时的选择代次，代次变化即用户已作出其他选择，
 * 这时不打开，也不取消用户正在等待的节点。
 */
export function openNodeById(id: string, since?: Pick): void {
  if (!since) { picks++; since = pickNow(); }
  if (!samePick(since)) return;
  waiting?.(); waiting = null;
  const node = findNode(id);
  if (node) { openNode(node); return; }
  const source = id.slice(0, id.indexOf(":"));
  if (!source) { toast("该节点不在会话列表中", "warning"); return; }
  pinNode(source, id); void loadTree(source);
  const mine = since;
  const stop = () => { clearTimeout(timer); off(); if (waiting === stop) waiting = null; };
  const off = trees.subscribe(() => {
    if (!samePick(mine)) { stop(); return; }
    const found = findNode(id);
    if (found) { stop(); openNode(found); }
  });
  const timer = setTimeout(() => { stop(); toast("该节点不在会话列表中，可能已被删除", "warning"); }, 10000);
  waiting = stop;
}

/**
 * 动作结果里的 openNodeId 用的打开函数，在发起动作时调用以记下选择代次。结果返回前用户已切换到其他会话或节点、
 * 或点击了还在等待出现的节点时不跳转，只提示，旧操作的结果不覆盖用户之后的选择（development.md“旧请求不能覆盖新选择”）。
 */
export function openFromResult(): (nodeId: string) => void {
  const since = pickNow();
  return (id) => {
    if (samePick(since)) { openNodeById(id, since); return; }
    const node = findNode(id);
    toast(`操作已完成，结果${node ? "“" + nodeLabel(node) + "”" : "节点"}可在会话列表中打开`);
  };
}
