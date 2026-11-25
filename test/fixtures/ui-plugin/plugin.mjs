// 浏览器插件界面测试用的插件：树（含挂在主会话下的节点和冷历史）、插件会话、动作、持久表单、横幅、通知、面板和自定义消息。
// 与服务端同进程加载，测试通过 globalThis.__uiPlugin 驱动它。
const EPOCH = "ui-tree";
const STREAM = "ui-stream";
const now = () => new Date().toISOString();

export default function createPlugin() {
  let ctx;
  let revision = 10;
  const nodes = new Map();
  const cold = new Map();          // 只能通过 children() 取到的历史节点
  const foreign = {};              // 挂在主会话下的子节点数
  const treeListeners = new Set();
  const changes = [];
  const sessions = new Map();      // id → { entries, seq, status, readonly, listeners: Set }
  const operations = new Map();    // 幂等键 → { digest, result | promise }
  const handled = new Map();       // formId → revision
  const forms = new Map();
  const calls = { invoke: [], submit: [], send: [], abort: 0, resolveForm: 0, presence: [] };
  let slowRelease;
  let noteRelease;
  let branches = 0;

  const node = (id, extra) => ({ id, source: "uitest", kind: "session", parentId: null, title: id, status: "idle", availability: "online",
    hasChildren: false, sortKey: id, revision, capabilities: ["open", "subscribe"], ...extra });
  const push = (change) => { changes.push(change); for (const emit of treeListeners) emit(structuredClone(change)); };
  const upsert = (value) => { const n = { ...value, revision: ++revision }; nodes.set(n.id, n); push({ type: "upsert", revision: n.revision, node: structuredClone(n) }); return n; };
  const session = (id) => { let s = sessions.get(id); if (!s) { s = { entries: [], seq: 0, log: [], status: "idle", readonly: false, listeners: new Set() }; sessions.set(id, s); } return s; };
  const emitSession = (id, event) => {
    const s = session(id); s.seq++;
    const record = { ref: { source: "uitest", id }, cursor: { epoch: STREAM, seq: s.seq }, event: structuredClone(event) };
    s.log.push(record);
    for (const emit of s.listeners) emit(structuredClone(record));
  };

  // 初始树：根分组下一个运行中的会话，另有两个冷历史节点。
  nodes.set("uitest:group:tasks", node("uitest:group:tasks", { kind: "group", title: "测试任务", hasChildren: true, childCount: 4, sortKey: "0" }));
  nodes.set("uitest:session:a", node("uitest:session:a", { parentId: "uitest:group:tasks", title: "任务甲", status: "running", sessionRef: { source: "uitest", id: "a" },
    capabilities: ["open", "subscribe", "send", "abort", "action:uitest.retry"], sortKey: "1" }));
  cold.set("uitest:session:old", node("uitest:session:old", { parentId: "uitest:group:tasks", title: "历史任务", status: "done", availability: "archived",
    sessionRef: { source: "uitest", id: "old" }, sortKey: "2", lastActivityAt: "2020-01-01T00:00:00.000Z", revision: 1 }));
  cold.set("uitest:session:old2", node("uitest:session:old2", { parentId: "uitest:group:tasks", title: "更早的任务", status: "failed", availability: "archived",
    sessionRef: { source: "uitest", id: "old2" }, sortKey: "3", lastActivityAt: "2020-01-01T00:00:00.000Z", revision: 1 }));
  // 排队中的任务：等待中、还没有运行，但可以停止；动作多于标题栏能放下的 3 个；输入框按 composerMode 返回不同结果。
  nodes.set("uitest:session:d", node("uitest:session:d", { parentId: "uitest:group:tasks", title: "排队的任务", status: "waiting", sessionRef: { source: "uitest", id: "d" },
    capabilities: ["open", "subscribe", "send", "abort", "action:uitest.retry", "action:uitest.steer", "action:uitest.extra1", "action:uitest.extra2"],
    composer: { actionId: "uitest.note", placeholder: "给排队的任务留言" }, sortKey: "1d" }));
  session("a").status = "running";
  session("d").status = "waiting";
  session("a").entries = [{ type: "message", id: "a1", parentId: null, timestamp: now(), message: { role: "user", content: [{ type: "text", text: "开始任务甲" }], timestamp: Date.now() } }];
  session("old").readonly = true;

  const control = {
    calls, forms, sessions, nodes,
    /** 在主会话下挂一个子会话节点，originToolCall 指向主会话里的工具调用。 */
    attach(mainId, toolCallId, title = "子任务乙") {
      const parentId = "pane:session:" + mainId;
      foreign[parentId] = (foreign[parentId] ?? 0) + 1;
      session("b").entries = [{ type: "message", id: "b1", parentId: null, timestamp: now(), message: { role: "user", content: [{ type: "text", text: "子任务乙的输入" }], timestamp: Date.now() } }];
      return upsert(node("uitest:session:b", { parentId, title, sessionRef: { source: "uitest", id: "b" }, status: "running",
        capabilities: ["open", "subscribe", "send", "abort", "action:uitest.retry"], composer: { actionId: "uitest.steer", placeholder: "给子任务乙发消息" },
        ...(toolCallId ? { originToolCall: { sessionRef: { source: "pane", id: mainId }, toolCallId } } : {}) }));
    },
    upsert, setStatus(id, status, extra = {}) { return upsert({ ...nodes.get(id), status, ...extra }); },
    remove(id) { nodes.delete(id); push({ type: "remove", id, revision: ++revision }); },
    reset() { treeListeners.forEach((emit) => emit({ type: "reset", epoch: EPOCH })); },
    emit: emitSession,
    append(id, text) {
      const s = session(id);
      const entry = { type: "message", id: "e" + (s.entries.length + 1), parentId: s.entries.at(-1)?.id ?? null, timestamp: now(),
        message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), stopReason: "stop" } };
      s.entries.push(entry);
      emitSession(id, { type: "pane_entries", entries: [entry], leafId: entry.id });
    },
    resync(id) { emitSession(id, { type: "resync" }); },
    /** 换掉会话的当前分支：快照只给 current，更早的 older 要点“加载更早的消息”取得。 */
    branch(id, older, current) {
      const s = session(id);
      const entry = (text, i, prefix) => ({ type: "message", id: `${prefix}${i}`, parentId: null, timestamp: now(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
      const tag = "b" + (++branches) + "-";
      s.older = older.map((text, i) => entry(text, i, tag + "o")); s.entries = current.map((text, i) => entry(text, i, tag + "c"));
    },
    /** 只改树节点的 send 能力和快照中的 readonly，不在会话流里推 pane_status（如接管后开放输入）。 */
    setSend(nodeId, sessionId, on) {
      session(sessionId).readonly = !on;
      const current = nodes.get(nodeId);
      return upsert({ ...current, capabilities: on ? [...new Set([...current.capabilities, "send"])] : current.capabilities.filter((c) => c !== "send") });
    },
    setReadonly(id, readonly) { const s = session(id); s.readonly = readonly; emitSession(id, { type: "pane_status", status: s.status, phase: "idle", readonly }); },
    addForm(form) { const value = { source: "uitest", revision: 1, createdAt: now(), ...form }; forms.set(value.id, value); ctx.formAdded(structuredClone(value)); return value; },
    removeForm(id, reason = "withdrawn") { forms.delete(id); ctx.formRemoved(id, reason); },
    banner(banner) { ctx.setBanner(banner); }, clearBanner(id) { ctx.clearBanner(id); },
    notify(notification) { ctx.notify({ source: "uitest", ...notification }); },
    panelChanged(update) { ctx.panelChanged(update); },
    releaseSlow() { slowRelease?.(); },
    /** 下一次取快照失败的次数（模拟后台离线）。 */
    failSnapshots: 0,
    /** 普通发送（sessions.send）的结果：ok 受理并回显；pending 已受理仍在处理，之后由 finishPending 给出最终结果。 */
    sendMode: "ok",
    /** 输入框动作 uitest.note 的结果：ok、reject、pending、slow（超过动作超时）、hold（等 releaseNote）、needsInput。 */
    composerMode: "ok",
    releaseNote() { noteRelease?.(); },
    /** 把处于 pending 的操作改为最终结果，之后用同一个键查询得到它。 */
    finishPending(result = { status: "ok", message: "留言已处理" }) { for (const op of operations.values()) if (op.pending) { op.result = result; op.pending = false; } },
  };
  globalThis.__uiPlugin = control;

  const respond = async (key, digest, run) => {
    const known = operations.get(key);
    if (known) {
      if (known.digest !== digest) return { status: "idempotencyConflict", message: "同一个键对应了不同的操作" };
      return known.result ?? { status: "pending" };
    }
    const op = { digest }; operations.set(key, op);
    const result = await run(); if (result.status !== "pending") op.result = result; else op.pending = true; return result;
  };

  return {
    id: "uitest",
    displayName: "测试插件",
    paneProtocol: [1, 1],
    async activate(context) { ctx = context; },
    async deactivate() { treeListeners.clear(); for (const s of sessions.values()) s.listeners.clear(); },
    tree: {
      async snapshot(req) {
        const open = new Set(req.openNodeIds);
        const list = [...nodes.values()].filter((n) => !cold.has(n.id) || open.has(n.id));
        return { source: "uitest", epoch: EPOCH, revision, nodes: structuredClone(list), foreignChildCounts: { ...foreign } };
      },
      async children(parentId, page) {
        if (page.epoch !== EPOCH) return { reset: true, epoch: EPOCH };
        const all = [...nodes.values(), ...cold.values()].filter((n) => n.parentId === parentId).sort((a, b) => a.sortKey < b.sortKey ? -1 : 1);
        const offset = Number(page.cursor ?? 0); const slice = all.slice(offset, offset + page.limit);
        return { epoch: EPOCH, revision, nodes: structuredClone(slice), ...(offset + slice.length < all.length ? { nextCursor: String(offset + slice.length) } : {}) };
      },
      subscribe(from, emit) {
        if (from.epoch !== EPOCH || from.revision > revision) { emit({ type: "reset", epoch: EPOCH }); return () => {}; }
        for (const change of changes) if (change.revision > from.revision) emit(structuredClone(change));
        treeListeners.add(emit); return () => treeListeners.delete(emit);
      },
    },
    sessions: {
      async snapshot(ref) {
        if (control.failSnapshots > 0) { control.failSnapshots--; throw new Error("会话服务已关闭"); }
        const s = session(ref.id);
        return { ref, cursor: { epoch: STREAM, seq: s.seq }, leafId: s.entries.at(-1)?.id ?? null, entries: structuredClone(s.entries),
          historyBefore: s.older?.length ? s.entries[0]?.id ?? null : null,
          status: s.status, readonly: s.readonly, ...(s.readonly ? { readonlyReason: "archived" } : {}), controlRevision: 1 };
      },
      async history(ref) { return { entries: structuredClone(session(ref.id).older ?? []), historyBefore: null }; },
      subscribe(ref, after, emit) {
        // 按游标重放之后的事件；游标不属于本流或超前时要求重取快照。
        const s = session(ref.id);
        if (after.epoch !== STREAM || after.seq > s.seq) emit({ ref, cursor: { epoch: STREAM, seq: s.seq + 1 }, event: { type: "resync" } });
        else for (const record of s.log) if (record.cursor.seq > after.seq) emit(structuredClone(record));
        s.listeners.add(emit); return () => s.listeners.delete(emit);
      },
      async send(ref, input, req) {
        calls.send.push({ ref, input, key: req.idempotencyKey });
        return respond(req.idempotencyKey, JSON.stringify([ref, input]), async () => {
          if (control.sendMode === "pending") return { status: "pending" };
          control.append(ref.id, "收到：" + input.text); return { status: "accepted" };
        });
      },
      async abort(ref) {
        calls.abort++; const s = session(ref.id); s.status = "stopped";
        emitSession(ref.id, { type: "pane_status", status: "stopped", phase: "idle" });
        control.setStatus("uitest:session:" + ref.id, "stopped");
        return { status: "done", clearedText: ["排队的消息"] };
      },
    },
    panels: {
      list: () => [
        { id: "uitest.detail", source: "uitest", title: "任务详情", placement: "node", revision: 1 },
        { id: "uitest.board", source: "uitest", title: "测试看板", placement: "sidebar", badgeCount: 2, revision: 1 },
        { id: "uitest.future", source: "uitest", title: "将来的面板", placement: "node", appliesTo: { kinds: ["group"] }, revision: 1 },
        { id: "uitest.checklist", source: "uitest", title: "任务清单", placement: "node", appliesTo: { kinds: ["session"], sources: ["uitest"] }, revision: 1 },
        { id: "uitest.main", source: "uitest", title: "主会话面板", placement: "node", appliesTo: { kinds: ["session"], sources: ["pane"] }, revision: 1 },
      ],
      async content(panelId, nodeId) {
        if (panelId === "uitest.detail") return { type: "keyValue", rows: [{ key: "节点", value: nodeId ?? "" }, { key: "状态", value: nodes.get(nodeId)?.status ?? "" }] };
        if (panelId === "uitest.board") return { type: "list", items: [{ id: "row1", title: "看板条目", nodeId: "uitest:session:a", actions: ["uitest.retry"] }] };
        if (panelId === "uitest.checklist") return { type: "list", items: [{ id: "row1", title: "清单条目", actions: ["uitest.retry"] }] };
        if (panelId === "uitest.main") return { type: "keyValue", rows: [{ key: "主会话", value: nodeId ?? "" }] };
        return { type: "hologram", frames: [] };
      },
    },
    actions: {
      list: () => [
        { id: "uitest.retry", source: "uitest", title: "返工", scope: ["node", "panelRow"], hasForm: true },
        { id: "uitest.steer", source: "uitest", title: "插话", scope: ["node"] },
        { id: "uitest.ping", source: "uitest", title: "检查状态", scope: ["global"] },
        { id: "uitest.slow", source: "uitest", title: "慢动作", scope: ["global"], timeoutMs: 1000 },
        { id: "uitest.create", source: "uitest", title: "新建任务", scope: ["global"] },
        { id: "uitest.wipe", source: "uitest", title: "清空", scope: ["global"], confirm: "确定清空？", danger: true },
        { id: "uitest.note", source: "uitest", title: "留言", scope: ["node"], timeoutMs: 1000 },
        { id: "uitest.extra1", source: "uitest", title: "附加一", scope: ["node"] },
        { id: "uitest.extra2", source: "uitest", title: "附加二", scope: ["node"] },
      ],
      async resolveForm(actionId, target) {
        calls.resolveForm++;
        if (actionId !== "uitest.retry") return null;
        return { id: "retry-" + (target?.nodeId ?? target?.rowId ?? "x"), source: "uitest", revision: 1, title: "返工说明", createdAt: now(),
          fields: [{ id: "note", label: "返工要求", type: "textarea", required: true }] };
      },
      async invoke(inv, origin) {
        calls.invoke.push({ ...inv, origin });
        return respond(inv.idempotencyKey, JSON.stringify([inv.actionId, inv.target, inv.input]), async () => {
          if (inv.actionId === "uitest.slow") {
            await new Promise((resolve) => { slowRelease = resolve; setTimeout(resolve, 30000); });
            return { status: "ok", message: "慢动作完成" };
          }
          if (inv.actionId === "uitest.create") {
            // 树变更晚于动作结果到达浏览器：节点在返回结果之后才推送。
            setTimeout(() => upsert(node("uitest:session:c", { parentId: "uitest:group:tasks", title: "新建的任务", sessionRef: { source: "uitest", id: "c" }, sortKey: "4" })), 300);
            return { status: "ok", message: "已新建任务", openNodeId: "uitest:session:c" };
          }
          if (inv.actionId === "uitest.ping") return { status: "ok", message: "状态正常", openNodeId: "uitest:session:a" };
          if (inv.actionId === "uitest.note") {
            const mode = control.composerMode;
            if (mode === "reject") return { status: "failed", message: "插件拒绝了留言" };
            if (mode === "pending") return { status: "pending", message: "留言处理中" };
            if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 3000));
            if (mode === "hold") await new Promise((resolve) => { noteRelease = resolve; });
            if (mode === "needsInput" && !inv.formId) return { status: "needsInput", followUpForm: { id: "note-more", source: "uitest", revision: 1, title: "补充留言", createdAt: now(), fields: [{ id: "more", label: "补充", type: "text" }] } };
            control.append("d", "留言：" + inv.input?.fields?.message);
            return { status: "ok", message: "已留言" };
          }
          if (inv.actionId === "uitest.steer") { control.append(inv.target.nodeId.split(":").pop(), "插话：" + inv.input?.fields?.message); return { status: "ok", message: "已插话" }; }
          return { status: "ok", message: "已" + (inv.actionId === "uitest.retry" ? "返工" : "执行") };
        });
      },
    },
    forms: {
      async pending() { return structuredClone([...forms.values()]); },
      async submit(req, origin) {
        calls.submit.push({ ...req, origin });
        const form = forms.get(req.formId);
        if (!form) return { status: "alreadyHandled", message: "已在别处处理" };
        if (req.revision < form.revision) return { status: "stale", form: structuredClone(form) };
        return respond(req.idempotencyKey, JSON.stringify([req.formId, req.revision, req.outcome]), async () => {
          if (handled.has(req.formId)) return { status: "alreadyHandled", message: "已在别处处理" };
          handled.set(req.formId, req.revision);
          // pending 表单：插件受理后仍在处理，之后用同一个键查询得到 finishPending 给出的结果。
          if (form.pending) return { status: "pending", message: "等待处理" };
          if (form.presence) {
            try {
              const proof = await ctx.userPresence.confirm({ title: "确认答复", summary: "答复 **" + form.title + "**", payload: { formId: form.id, outcome: req.outcome }, origin, timeoutMs: form.presence });
              calls.presence.push({ formId: form.id, deviceId: proof.deviceId });
            } catch (error) {
              handled.delete(req.formId);
              return { status: "failed", message: "确认失败：" + (error?.code ?? error?.message) };
            }
          }
          forms.delete(req.formId); ctx.formRemoved(req.formId, "handled");
          return { status: "accepted", message: "已提交" };
        });
      },
    },
    renderers: { customMessages: [{ customType: "uitest:notice", label: "测试通知", collapsed: false, fields: [{ path: "task.id", label: "任务" }], nodeIdPath: "task.nodeId" }] },
  };
}
