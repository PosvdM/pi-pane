// 第二个界面测试插件：节点挂在另一个插件（uitest）的节点下，侧栏面板与 uitest 同名，用于验证跨来源的树和按来源区分的面板。
// 测试通过 globalThis.__uiPlugin2 驱动它。
const EPOCH = "ui2-tree";

export default function createPlugin() {
  let ctx;
  const revision = 3;
  const node = (id, extra) => ({ id, source: "uitest2", kind: "session", parentId: null, title: id, status: "idle", availability: "online",
    hasChildren: false, sortKey: id, revision: 1, capabilities: [], ...extra });
  const nodes = [
    // 挂在 uitest 的分组下；该分组下另有一个只能分页取到的冷节点。
    node("uitest2:session:guest", { parentId: "uitest:group:tasks", title: "外来任务", status: "running" }),
    // 自己的根：有子节点但不提供数目。
    node("uitest2:group:root", { kind: "group", title: "第二插件根", hasChildren: true }),
    // 资源节点：点击时打开适用的面板。
    node("uitest2:resource:doc", { kind: "resource", parentId: "uitest2:group:root", title: "说明文档", resourceRef: { source: "uitest2", type: "doc", id: "doc" } }),
    // 父节点在 uitest 中不存在：归入“未归属”。
    node("uitest2:session:stray", { parentId: "uitest:group:gone", title: "走失的任务", status: "running" }),
  ];
  const cold = [
    node("uitest2:session:guest-old", { parentId: "uitest:group:tasks", title: "外来旧任务", status: "done", availability: "archived" }),
    node("uitest2:session:root-old", { parentId: "uitest2:group:root", title: "第二插件旧任务", status: "done", availability: "archived" }),
  ];
  globalThis.__uiPlugin2 = { panelChanged(update) { ctx.panelChanged(update); } };
  return {
    id: "uitest2",
    displayName: "第二测试插件",
    paneProtocol: [1, 1],
    async activate(context) { ctx = context; },
    tree: {
      async snapshot() { return { source: "uitest2", epoch: EPOCH, revision, nodes: structuredClone(nodes), foreignChildCounts: { "uitest:group:tasks": 2 } }; },
      async children(parentId, page) {
        if (page.epoch !== EPOCH) return { reset: true, epoch: EPOCH };
        return { epoch: EPOCH, revision, nodes: structuredClone([...nodes, ...cold].filter((n) => n.parentId === parentId)) };
      },
      subscribe(from, emit) { if (from.epoch !== EPOCH) emit({ type: "reset", epoch: EPOCH }); return () => {}; },
    },
    panels: {
      list: () => [
        { id: "uitest.board", source: "uitest2", title: "第二看板", placement: "sidebar", badgeCount: 7, revision: 1 },
        { id: "uitest2.doc", source: "uitest2", title: "文档内容", placement: "node", appliesTo: { kinds: ["resource"], resourceTypes: ["doc"] }, revision: 1 },
      ],
      async content(panelId) { return { type: "markdown", markdown: panelId === "uitest2.doc" ? "资源文档内容" : "第二插件的看板" }; },
    },
  };
}
