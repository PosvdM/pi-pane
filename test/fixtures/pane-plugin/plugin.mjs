/** @typedef {import('../../../packages/plugin-api/dist/index.js').PanePlugin} PanePlugin */
/** @typedef {import('../../../packages/plugin-api/dist/index.js').PaneHostContext} PaneHostContext */
/** @typedef {import('../../../packages/plugin-api/dist/index.js').TreeNode} TreeNode */
/** @typedef {import('../../../packages/plugin-api/dist/index.js').TreeChange} TreeChange */
/** @typedef {import('../../../packages/plugin-api/dist/index.js').SessionStreamEvent} SessionStreamEvent */
/** @typedef {import('../../../packages/plugin-api/dist/index.js').ActionResult} ActionResult */
/** @typedef {import('../../../packages/plugin-api/dist/index.js').FormSpec} FormSpec */
/** @typedef {{ invocations: Record<string, number>; submitted: number; active: boolean }} Inspection */

const TREE_EPOCH = 'sample-tree';
const STREAM_EPOCH = 'sample-stream';
const BUFFER_SIZE = 3;
const ROOT = 'sample:group:root';
const CHILD = 'sample:session:child';
const REF = { source: 'sample', id: 'child' };

/** @param {unknown} value @returns {string} */
function digest(value) {
  if (Array.isArray(value)) return '[' + value.map(digest).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const fields = /** @type {Record<string, unknown>} */ (value);
    return '{' + Object.keys(fields).filter(key => fields[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + digest(fields[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** @param {import('../../../packages/plugin-api/dist/index.js').SessionRef} ref */
function assertSession(ref) {
  if (ref.source !== REF.source || ref.id !== REF.id) throw new Error('示例会话不存在');
}

/** @returns {PanePlugin & { inspection(): Inspection }} */
export default function createPlugin() {
  /** @type {PaneHostContext | undefined} */
  let ctx;
  let active = false;
  let revision = 1;
  let seq = 0;
  let submitted = 0;
  /** @type {Record<string, number>} */
  const invocations = {};
  /** @type {Map<string, { digest: string; result?: ActionResult; error?: unknown; failed?: boolean; retryable?: boolean }>} */
  const operations = new Map();
  /** @type {Map<string, string>} */
  const submissions = new Map();
  /** @type {Set<(change: TreeChange) => void>} */
  const treeListeners = new Set();
  /** @type {Set<(event: SessionStreamEvent) => void>} */
  const streamListeners = new Set();
  /** @type {TreeChange[]} */
  const treeBuffer = [];
  /** @type {SessionStreamEvent[]} */
  const streamBuffer = [];
  /** @type {(() => void)[]} */
  let disposers = [];
  /** @type {FormSpec} */
  const question = {
    id: 'question', source: 'sample', revision: 1, title: '测试提问',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  /** @type {TreeNode} */
  const root = {
    id: ROOT, source: 'sample', kind: 'group', parentId: null, title: '示例分组',
    status: 'idle', availability: 'online', hasChildren: true, childCount: 1,
    sortKey: '0', revision: 1, capabilities: [],
  };
  /** @type {TreeNode} */
  const child = {
    id: CHILD, source: 'sample', kind: 'session', parentId: ROOT, title: '示例会话',
    sessionRef: REF, status: 'idle', availability: 'online', hasChildren: false,
    sortKey: '0', revision: 1, capabilities: ['open', 'subscribe', 'action:sample.echo'],
  };

  /** @type {PanePlugin & { inspection(): Inspection }} */
  const plugin = {
    id: 'sample',
    paneProtocol: [1, 1],
    async activate(context) {
      ctx = context;
      active = true;
      ctx.setBanner({ id: 'persistent', persistent: true, level: 'warning', title: '持久提示' });
      ctx.setBanner({ id: 'temporary', level: 'info', title: '临时提示' });
      if (!submitted) ctx.formAdded(structuredClone(question));
      disposers.push(ctx.mainSessions.onChange(() => {}), ctx.userPresence.onDevicesChange(() => {}));
    },
    async deactivate() {
      active = false;
      for (const dispose of disposers) dispose();
      disposers = [];
      treeListeners.clear();
      streamListeners.clear();
      ctx = undefined;
    },
    inspection() { return { invocations: { ...invocations }, submitted, active }; },
    tree: {
      async snapshot() {
        return { source: 'sample', epoch: TREE_EPOCH, revision, nodes: structuredClone([root, child]) };
      },
      async children(parentId, page) {
        if (page.epoch !== TREE_EPOCH) return { reset: true, epoch: TREE_EPOCH };
        if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw new Error('分页大小无效');
        const offset = page.cursor === undefined ? 0 : Number(page.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0 || (page.cursor !== undefined && String(offset) !== page.cursor)) {
          throw new Error('分页游标无效');
        }
        const children = [root, child].filter(node => node.parentId === parentId);
        const nodes = structuredClone(children.slice(offset, offset + page.limit));
        return {
          epoch: TREE_EPOCH, revision, nodes,
          ...(offset + nodes.length < children.length ? { nextCursor: String(offset + nodes.length) } : {}),
        };
      },
      subscribe(from, emit) {
        const floor = treeBuffer.length ? /** @type {{ revision: number }} */ (treeBuffer[0]).revision - 1 : revision;
        if (from.epoch !== TREE_EPOCH || !Number.isSafeInteger(from.revision) || from.revision < floor || from.revision > revision) {
          emit({ type: 'reset', epoch: TREE_EPOCH });
          return () => {};
        }
        treeListeners.add(emit);
        for (const change of treeBuffer) {
          if ('revision' in change && change.revision > from.revision) emit(structuredClone(change));
        }
        return () => { treeListeners.delete(emit); };
      },
    },
    sessions: {
      async snapshot(ref) {
        assertSession(ref);
        return {
          ref: { ...REF }, cursor: { epoch: STREAM_EPOCH, seq }, leafId: null,
          entries: [], historyBefore: null, status: 'idle', readonly: true,
        };
      },
      async history(ref) {
        assertSession(ref);
        return { entries: [], historyBefore: null };
      },
      subscribe(ref, after, emit) {
        assertSession(ref);
        const floor = streamBuffer.length ? streamBuffer[0].cursor.seq - 1 : seq;
        if (after.epoch !== STREAM_EPOCH || !Number.isSafeInteger(after.seq) || after.seq < floor || after.seq > seq) {
          emit({ ref: { ...REF }, cursor: { epoch: STREAM_EPOCH, seq }, event: { type: 'resync' } });
          return () => {};
        }
        streamListeners.add(emit);
        for (const event of streamBuffer) if (event.cursor.seq > after.seq) emit(structuredClone(event));
        return () => { streamListeners.delete(emit); };
      },
    },
    panels: {
      list() { return [{ id: 'sample.panel', source: 'sample', title: '示例面板', placement: 'sidebar', revision: 1 }]; },
      async content(panelId) {
        if (panelId !== 'sample.panel') throw new Error('示例面板不存在');
        return { type: 'keyValue', rows: [{ key: '来源', value: 'sample' }] };
      },
    },
    forms: {
      async pending() { return submitted ? [] : [structuredClone(question)]; },
      async submit(req) {
        const { idempotencyKey, ...content } = req;
        const summary = digest(content);
        if (submissions.has(idempotencyKey) && submissions.get(idempotencyKey) !== summary) {
          return { status: 'idempotencyConflict', message: '同一操作标识对应不同内容' };
        }
        submissions.set(idempotencyKey, summary);
        if (submitted || req.formId !== question.id || req.revision !== question.revision) return { status: 'alreadyHandled' };
        submitted++;
        ctx?.formRemoved(question.id, req.outcome.status === 'cancelled' ? 'cancelled' : 'handled');
        return { status: 'accepted' };
      },
    },
    actions: {
      list() {
        return ['echo', 'slow', 'throw', 'form', 'presence', 'emit'].map(name => ({
          id: 'sample.' + name, source: 'sample', title: '测试动作：' + name, scope: ['global', 'node'],
          ...(name === 'form' ? { hasForm: true } : {}),
          ...(name === 'slow' ? { timeoutMs: 10 } : {}),
        }));
      },
      async resolveForm(actionId) {
        return actionId === 'sample.form' ? {
          ...question, id: 'action-form', title: '动作输入',
          fields: [{ id: 'message', label: '消息', type: 'text' }],
        } : null;
      },
      async invoke(inv, origin) {
        const { idempotencyKey, ...content } = structuredClone(inv);
        const summary = digest(content);
        const previous = operations.get(idempotencyKey);
        if (previous) {
          if (previous.digest !== summary) return { status: 'idempotencyConflict', message: '同一操作标识对应不同内容' };
          if (previous.failed) throw previous.error;
          if (!previous.retryable) return structuredClone(previous.result ?? { status: 'pending' });
        }
        const operation = { digest: summary, .../** @type {{ result?: ActionResult; error?: unknown; failed?: boolean; retryable?: boolean }} */ ({}) };
        operations.set(idempotencyKey, operation);
        invocations[content.actionId] = (invocations[content.actionId] ?? 0) + 1;
        try {
          if (content.actionId === 'sample.slow') await new Promise(resolve => setTimeout(resolve, 80));
          else if (content.actionId === 'sample.throw') throw new Error('示例动作异常');
          else if (content.actionId === 'sample.presence') {
            if (!ctx) throw new Error('示例插件未激活');
            await ctx.userPresence.confirm({ title: '确认测试动作', summary: '请确认示例动作的输入。', payload: content.input?.fields ?? {}, origin });
          } else if (content.actionId === 'sample.emit') {
            child.revision = ++revision;
            /** @type {TreeChange} */
            const change = { type: 'upsert', revision, node: structuredClone(child) };
            /** @type {SessionStreamEvent} */
            const event = { ref: { ...REF }, cursor: { epoch: STREAM_EPOCH, seq: ++seq }, event: { type: 'pane_status', status: 'idle', phase: 'idle' } };
            treeBuffer.push(change);
            streamBuffer.push(event);
            if (treeBuffer.length > BUFFER_SIZE) treeBuffer.shift();
            if (streamBuffer.length > BUFFER_SIZE) streamBuffer.shift();
            for (const listener of treeListeners) listener(structuredClone(change));
            for (const listener of streamListeners) listener(structuredClone(event));
          } else if (!['sample.echo', 'sample.form'].includes(content.actionId)) throw new Error('示例动作不存在');
          const message = content.input?.fields?.message;
          operation.result = { status: 'ok', ...(typeof message === 'string' ? { message } : {}) };
          return structuredClone(operation.result);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'timeout') {
            operation.retryable = true;
          } else {
            operation.failed = true;
            operation.error = error;
          }
          throw error;
        }
      },
    },
  };
  return plugin;
}
