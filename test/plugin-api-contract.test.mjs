import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import { isInterfaceDeclaration, isTypeAliasDeclaration, SyntaxKind } from 'typescript/unstable/ast';
import { PANE_PROTOCOL, negotiateProtocol } from '@pi-pane/plugin-api';
import createPlugin from './fixtures/pane-plugin/plugin.mjs';

const REF = { source: 'sample', id: 'child' };
const ROOT = 'sample:group:root';
const CHILD = 'sample:session:child';
const origin = { client: 'browser', connectionId: 'tab-1', deviceId: 'device-1', receivedAt: '2026-01-01T00:00:00.000Z' };
const request = { openNodeIds: [ROOT], recentSince: '2026-01-01T00:00:00.000Z' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invocation = (actionId, idempotencyKey, message) => ({ actionId, idempotencyKey, ...(message === undefined ? {} : { input: { answers: [], fields: { message } } }) });
const submission = (idempotencyKey, changes = {}) => ({ formId: 'question', revision: 1, outcome: { status: 'submitted', values: { answers: [] } }, idempotencyKey, ...changes });

async function fixture(t, confirm = async () => ({ deviceId: 'device-1', publicKey: '公钥', alg: 'ECDSA-P256-SHA256', signature: '签名' })) {
  const plugin = createPlugin();
  const banners = new Map();
  const added = [], removed = [], confirmations = [];
  const mainListeners = new Set(), deviceListeners = new Set();
  const watch = listeners => listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const ctx = {
    paneProtocol: 1, dataDir: '测试目录', log: { info() {}, warn() {}, error() {} },
    notify() {}, panelChanged() {},
    formAdded(form) { added.push(structuredClone(form)); },
    formRemoved(id, reason) { removed.push({ id, reason }); },
    setBanner(banner) { banners.set(banner.id, structuredClone(banner)); },
    clearBanner(id) { banners.delete(id); },
    listBanners() { return structuredClone([...banners.values()]); },
    mainSessions: { list: () => [], get: () => undefined, hold: () => () => {}, onChange: watch(mainListeners) },
    userPresence: {
      devices: () => [], onDevicesChange: watch(deviceListeners),
      async confirm(req) { confirmations.push(req); return confirm(req); },
    },
  };
  await plugin.activate(ctx);
  t.after(() => plugin.deactivate());
  return { plugin, ctx, added, removed, confirmations, mainListeners, deviceListeners };
}

function diagnostics(program) {
  return [
    ...program.getConfigFileParsingDiagnostics(), ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(),
  ].map(d => d.text).join('\n');
}

test('公共包的全部通用类型和示例插件可在隔离临时项目中编译', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'pane-plugin-contract-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const packageDir = path.join(home, 'node_modules/@pi-pane/plugin-api');
  await mkdir(packageDir, { recursive: true });
  const declarations = await readFile(new URL('../packages/plugin-api/dist/index.d.ts', import.meta.url), 'utf8');
  const fixtureSource = await readFile(new URL('./fixtures/pane-plugin/plugin.mjs', import.meta.url), 'utf8');
  await Promise.all([
    writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@pi-pane/plugin-api', type: 'module', exports: './index.d.ts' })),
    writeFile(path.join(packageDir, 'index.d.ts'), declarations),
    writeFile(path.join(home, 'package.json'), JSON.stringify({ type: 'module' })),
    writeFile(path.join(home, 'plugin.mjs'), fixtureSource.replaceAll('../../../packages/plugin-api/dist/index.js', '@pi-pane/plugin-api')),
  ]);
  const configPath = path.join(home, 'tsconfig.json');
  await writeFile(configPath, JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, allowJs: true, checkJs: true, skipLibCheck: false,
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: [],
      lib: ['ES2023', 'DOM'],
    },
    files: ['probe.ts'],
  }));
  await writeFile(path.join(home, 'probe.ts'), "import type * as API from '@pi-pane/plugin-api';\n");
  const api = new API({ cwd: home });
  t.after(() => api.close());
  const initial = api.updateSnapshot({ openProjects: [configPath] });
  const declarationAst = initial.getProject(configPath).program.getSourceFile(path.join(packageDir, 'index.d.ts'));
  const publicTypes = declarationAst.statements.filter(node =>
    (isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) && node.modifiers?.some(m => m.kind === SyntaxKind.ExportKeyword))
    .map(node => node.name.text).sort();
  initial.dispose();
  assert.ok(publicTypes.length > 40);
  const probe = `
import type * as API from '@pi-pane/plugin-api';
import createPlugin from './plugin.mjs';
const actual = createPlugin() satisfies API.PanePlugin;
const factory: API.PanePluginFactory = createPlugin;
// 等价实现逐个转发示例插件的通用接口，保留上下文类型检查。
const equivalent = {
  id: actual.id,
  paneProtocol: actual.paneProtocol,
  async activate(ctx) { await actual.activate(ctx); },
  async deactivate() { await actual.deactivate?.(); },
  tree: {
    async snapshot(req) { return actual.tree!.snapshot(req); },
    async children(id, page) { return actual.tree!.children(id, page); },
    subscribe(from, emit) { return actual.tree!.subscribe(from, emit); },
  },
  sessions: {
    async snapshot(ref) { return actual.sessions!.snapshot(ref); },
    async history(ref, page) { return actual.sessions!.history(ref, page); },
    subscribe(ref, after, emit) { return actual.sessions!.subscribe(ref, after, emit); },
    async send(ref, input, req) { return { status: 'rejected', message: input.text }; },
    async abort(ref, req) { return { status: 'nothingToStop' }; },
  },
  panels: {
    list() { return actual.panels!.list(); },
    async content(id, nodeId) { return actual.panels!.content(id, nodeId); },
  },
  actions: {
    list() { return actual.actions!.list(); },
    async resolveForm(id, target) { return actual.actions!.resolveForm!(id, target); },
    async invoke(inv, origin) { return actual.actions!.invoke(inv, origin); },
  },
  forms: {
    async pending() { return actual.forms!.pending(); },
    async submit(req, origin) { return actual.forms!.submit(req, origin); },
  },
  renderers: { customMessages: [{ customType: 'sample.notice', label: '测试消息' }] },
} satisfies API.PanePlugin;
export type PublicContracts = [${publicTypes.map(name => `API.${name}`).join(', ')}];
const origin: API.RequestOrigin = { client: 'browser', connectionId: '测试标签页', receivedAt: '2026-01-01T00:00:00.000Z' };
const ref: API.SessionRef = { source: 'sample', id: 'child' };
const answers: API.FormAnswers = { answers: [{ id: 'choice', selected: ['同意'] }], fields: { group: [{ text: '值' }] } };
const question: API.FormQuestion = { id: 'choice', question: '请选择', options: [{ label: '同意', recommended: true }] };
const field: API.FormField = { id: 'group', label: '分组', type: 'group', fields: [{ id: 'text', label: '值', type: 'text' }] };
const outcome: API.BridgeFormOutcome = { status: 'aborted' };
const status: API.PaneStatusEvent = { type: 'pane_status', status: 'idle', phase: 'idle', readonly: true };
const stream: API.SessionStreamEvent = { ref, cursor: { epoch: '测试流', seq: 0 }, event: { ...status } };
const block: API.InFlightBlock = { type: 'toolCall', contentIndex: 0, id: '调用', toolName: 'read', argsText: '{}', done: false };
const inFlight: API.InFlightState = { phase: 'tools', assistant: { startedAt: 0, blocks: [block] }, tools: [], queue: { steering: [], followUp: [] } };
const partial: API.UnfinishedPartial = { runId: '运行', at: origin.receivedAt, blocks: [block] };
const panels: API.PanelContent[] = [
  { type: 'markdown', markdown: '测试' }, { type: 'keyValue', rows: [{ key: '键', value: '值' }] },
  { type: 'table', columns: [{ key: '列', title: '列' }], rows: [{ rowId: '行', cells: { 列: '值' }, actions: ['sample.echo'] }] },
  { type: 'list', items: [{ id: '项', title: '条目' }] },
  { type: 'timeline', items: [{ id: '项', seq: 1, badge: '测试', author: '作者', markdown: '内容', time: origin.receivedAt }], hasMoreBefore: false },
  { type: 'steps', steps: [{ id: '步骤', title: '测试', status: 'done' }], progress: { current: 1, total: 1 } },
];
const banner: API.BannerState = { id: '提示', source: 'sample', sourceUnavailable: false, level: 'info', title: '测试' };
async function hostProbe(ctx: API.PaneHostContext) {
  ctx.log.info(question, field, outcome, stream, inFlight, partial, panels, banner);
  const sessions: API.MainSessionInfo[] = ctx.mainSessions.list();
  ctx.mainSessions.get('测试会话');
  ctx.mainSessions.onChange(() => {} )();
  ctx.mainSessions.hold(ref, '测试保活')();
  const devices: API.PresenceDevice[] = ctx.userPresence.devices();
  ctx.userPresence.onDevicesChange(() => {})();
  const proof: API.UserPresenceProof = await ctx.userPresence.confirm({ title: '确认', summary: '测试', payload: answers, origin });
  ctx.notify({ id: '通知', source: 'sample', level: 'info', title: '测试通知' });
  ctx.panelChanged({ panelId: 'sample.panel', revision: 1, badgeCount: null });
  ctx.setBanner(banner); ctx.listBanners(); ctx.clearBanner(banner.id);
  ctx.formAdded({ id: '表单', source: 'sample', revision: 1, title: '测试', createdAt: origin.receivedAt });
  ctx.formRemoved('表单', 'withdrawn');
  return { sessions, devices, proof, dataDir: ctx.dataDir, protocol: ctx.paneProtocol };
}
void factory; void equivalent; void hostProbe;
`;
  const probePath = path.join(home, 'probe.ts');
  await writeFile(probePath, probe);
  const checked = api.updateSnapshot({ fileChanges: { changed: [probePath] } });
  const program = checked.getProject(configPath).program;
  assert.equal(diagnostics(program), '', '全部通用接口与实际示例实现必须通过类型检查');
  assert.ok(program.getSourceFileNames().some(file => file.endsWith('/plugin.mjs') || file.endsWith('\\plugin.mjs')));
  const external = program.getSourceFileNames().filter(file => file.includes('node_modules') && !file.includes('typescript') && !file.includes('@pi-pane/plugin-api'));
  assert.deepEqual(external, [], '公共 API 不依赖原生 RPC 或其他生产包');
  checked.dispose();
  assert.doesNotMatch(declarations, /\b(?:ExtensionUiRequest|ControlRequest)\b|pi-rpc|pi-hostkit|@mariozechner/);
  // 负向探针确保编译测试确实检查导出名称和返回类型。
  await writeFile(probePath, probe + '\nconst invalid: API.ActionResult = { status: "不存在" };\ntype Missing = API.NotExported;\n');
  const rejected = api.updateSnapshot({ fileChanges: { changed: [probePath] } });
  const failures = diagnostics(rejected.getProject(configPath).program);
  rejected.dispose();
  assert.match(failures, /不存在/);
  assert.match(failures, /NotExported/);
});

test('协议协商拒绝双方畸形范围并选择通用版本交集', () => {
  assert.equal(negotiateProtocol([PANE_PROTOCOL, PANE_PROTOCOL]), PANE_PROTOCOL);
  for (const current of [2, 3, 9]) {
    const supported = [current - 1, current];
    assert.equal(negotiateProtocol([1, current + 1], supported), current);
    assert.equal(negotiateProtocol([current - 1, current - 1], supported), current - 1);
    assert.equal(negotiateProtocol([current, current + 10], supported), current);
    assert.throws(() => negotiateProtocol([current + 1, current + 2], supported), /不兼容/);
  }
  const malformed = [undefined, null, {}, '1,1', [], [1], [1, 2, 3], new Array(2), [0, 1], [-1, 1], [3, 2], [1.5, 2], [1, 1.5], [NaN, 1], [1, NaN], [Infinity, Infinity], [1, Infinity], [1, Number.MAX_SAFE_INTEGER + 1]];
  for (const range of malformed) {
    // undefined 在 supported 位置表示使用默认值，不属于显式无效范围。
    assert.throws(() => negotiateProtocol(range), /范围无效/);
    if (range !== undefined) assert.throws(() => negotiateProtocol([1, 1], range), /范围无效/);
  }
  assert.throws(() => negotiateProtocol([2, 3], [4, 5]), /不兼容/);
  assert.throws(() => negotiateProtocol([4, 5], [2, 3]), /不兼容/);
});

test('示例包入口是同步工厂且实例状态隔离', async t => {
  const manifest = JSON.parse(await readFile(new URL('./fixtures/pane-plugin/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.piPane.entry, './plugin.mjs');
  assert.deepEqual(manifest.piPane.paneProtocol, [1, 1]);
  const { default: factory } = await import(new URL(manifest.piPane.entry, new URL('./fixtures/pane-plugin/package.json', import.meta.url)));
  const first = factory(), second = factory();
  t.after(() => first.deactivate()); t.after(() => second.deactivate());
  assert.equal(first.then, undefined);
  assert.notEqual(first, second);
  assert.equal(first.id, 'sample'); assert.deepEqual(first.paneProtocol, [1, 1]);
  await first.actions.invoke(invocation('sample.emit', '隔离'), origin);
  assert.equal((await first.tree.snapshot(request)).revision, 2);
  assert.equal((await second.tree.snapshot(request)).revision, 1);
  assert.equal((await second.sessions.snapshot(REF)).cursor.seq, 0);
  const inspection = first.inspection(); inspection.invocations['sample.emit'] = 100;
  assert.equal(first.inspection().invocations['sample.emit'], 1);
});

test('激活发布横幅、持久表单与面板，停用取消全部监听', async t => {
  const { plugin, ctx, added, mainListeners, deviceListeners } = await fixture(t);
  assert.equal(plugin.inspection().active, true);
  assert.deepEqual(ctx.listBanners(), [
    { id: 'persistent', persistent: true, level: 'warning', title: '持久提示' },
    { id: 'temporary', level: 'info', title: '临时提示' },
  ]);
  assert.deepEqual(added, [{ id: 'question', source: 'sample', revision: 1, title: '测试提问', createdAt: '2026-01-01T00:00:00.000Z' }]);
  const banners = ctx.listBanners(); banners[0].title = '外部修改';
  assert.equal(ctx.listBanners()[0].title, '持久提示');
  ctx.clearBanner('temporary'); assert.equal(ctx.listBanners().length, 1);
  assert.deepEqual(plugin.panels.list().map(panel => panel.id), ['sample.panel']);
  assert.deepEqual(await plugin.panels.content('sample.panel'), { type: 'keyValue', rows: [{ key: '来源', value: 'sample' }] });
  await assert.rejects(plugin.panels.content('missing'), /不存在/);
  const trees = [], events = [];
  plugin.tree.subscribe({ epoch: 'sample-tree', revision: 1 }, change => trees.push(change));
  plugin.sessions.subscribe(REF, { epoch: 'sample-stream', seq: 0 }, event => events.push(event));
  assert.equal(mainListeners.size, 1); assert.equal(deviceListeners.size, 1);
  await plugin.deactivate();
  assert.equal(plugin.inspection().active, false);
  assert.equal(mainListeners.size, 0); assert.equal(deviceListeners.size, 0);
  await plugin.actions.invoke(invocation('sample.emit', '停用后'), origin);
  assert.deepEqual(trees, []); assert.deepEqual(events, []);
});

test('树快照、分页、切点重放和实时订阅保持来源级修订号', async t => {
  const { plugin } = await fixture(t);
  const snapshot = await plugin.tree.snapshot(request);
  assert.equal(snapshot.source, 'sample'); assert.equal(snapshot.epoch, 'sample-tree'); assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.nodes.map(node => [node.id, node.parentId]), [[ROOT, null], [CHILD, ROOT]]);
  assert.deepEqual(snapshot.nodes[1].sessionRef, REF);
  assert.deepEqual(snapshot.nodes[1].capabilities, ['open', 'subscribe', 'action:sample.echo']);
  assert.equal(snapshot.nodes[0].kind, 'group'); assert.equal(snapshot.nodes[1].kind, 'session');
  snapshot.nodes[1].title = '外部修改';
  const page = await plugin.tree.children(ROOT, { epoch: snapshot.epoch, limit: 1, cursor: '0' });
  assert.deepEqual(page.nodes.map(node => node.id), [CHILD]); assert.equal(page.nextCursor, undefined);
  assert.equal(page.nodes[0].title, '示例会话'); assert.equal(page.revision, 1);
  assert.deepEqual((await plugin.tree.children(ROOT, { epoch: snapshot.epoch, limit: 1, cursor: '1' })).nodes, []);
  assert.deepEqual((await plugin.tree.children(CHILD, { epoch: snapshot.epoch, limit: 2 })).nodes, []);
  assert.deepEqual(await plugin.tree.children(ROOT, { epoch: '过期', limit: 1 }), { reset: true, epoch: 'sample-tree' });
  for (const cursor of ['-1', 'bad', '1.2', '01']) await assert.rejects(plugin.tree.children(ROOT, { epoch: snapshot.epoch, limit: 1, cursor }), /游标无效/);
  await assert.rejects(plugin.tree.children(ROOT, { epoch: snapshot.epoch, limit: 0 }), /大小无效/);
  await plugin.actions.invoke(invocation('sample.emit', '树1'), origin);
  const received = [];
  const stop = plugin.tree.subscribe(snapshot, change => { received.push(change); if (change.type === 'upsert') change.node.title = '监听器修改'; });
  assert.deepEqual(received.map(change => change.revision), [2]);
  await plugin.actions.invoke(invocation('sample.emit', '树2'), origin);
  assert.deepEqual(received.map(change => change.revision), [2, 3]);
  assert.equal((await plugin.tree.snapshot(request)).nodes[1].title, '示例会话');
  stop(); await plugin.actions.invoke(invocation('sample.emit', '树3'), origin);
  assert.equal(received.length, 2);
  const atCut = [];
  const cutStop = plugin.tree.subscribe(await plugin.tree.snapshot(request), change => atCut.push(change));
  assert.deepEqual(atCut, []); cutStop();
});

test('树与会话缓冲边界允许连续重放，丢失、超前和非法切点要求重置', async t => {
  const { plugin } = await fixture(t);
  for (let i = 0; i < 5; i++) await plugin.actions.invoke(invocation('sample.emit', `缓冲${i}`), origin);
  const tree = [], stream = [];
  const stopTree = plugin.tree.subscribe({ epoch: 'sample-tree', revision: 3 }, change => tree.push(change));
  const stopStream = plugin.sessions.subscribe(REF, { epoch: 'sample-stream', seq: 2 }, event => stream.push(event));
  assert.deepEqual(tree.map(change => change.revision), [4, 5, 6]);
  assert.deepEqual(stream.map(event => event.cursor.seq), [3, 4, 5]);
  stopTree(); stopStream();
  for (const cursor of [{ epoch: '过期', revision: 6 }, ...[0, 2, 7, -1, 1.5, NaN, Infinity].map(revision => ({ epoch: 'sample-tree', revision }))]) {
    const resets = []; const stop = plugin.tree.subscribe(cursor, change => resets.push(change));
    assert.deepEqual(resets, [{ type: 'reset', epoch: 'sample-tree' }]);
    await plugin.actions.invoke(invocation('sample.echo', '无副作用'), origin); assert.equal(resets.length, 1); stop();
  }
  for (const cursor of [{ epoch: '过期', seq: 5 }, ...[0, 1, 6, -1, 1.5, NaN, Infinity].map(seq => ({ epoch: 'sample-stream', seq }))]) {
    const resets = []; const stop = plugin.sessions.subscribe(REF, cursor, event => resets.push(event));
    assert.equal(resets.length, 1); assert.deepEqual(resets[0].event, { type: 'resync' });
    assert.deepEqual(resets[0].cursor, { epoch: 'sample-stream', seq: 5 }); stop();
  }
});

test('会话只读快照、空历史、切点重放与取消订阅不依赖宿主', async t => {
  const { plugin } = await fixture(t);
  const snapshot = await plugin.sessions.snapshot(REF);
  assert.deepEqual(snapshot, { ref: REF, cursor: { epoch: 'sample-stream', seq: 0 }, leafId: null, entries: [], historyBefore: null, status: 'idle', readonly: true });
  assert.deepEqual(await plugin.sessions.history(REF, { before: '任意水位', limit: 2 }), { entries: [], historyBefore: null });
  for (const invalid of [{ source: 'other', id: 'child' }, { source: 'sample', id: 'missing' }]) {
    await assert.rejects(plugin.sessions.snapshot(invalid), /不存在/);
    await assert.rejects(plugin.sessions.history(invalid, { before: '', limit: 1 }), /不存在/);
    assert.throws(() => plugin.sessions.subscribe(invalid, snapshot.cursor, () => {}), /不存在/);
  }
  await plugin.actions.invoke(invocation('sample.emit', '会话1'), origin);
  const received = [];
  const stop = plugin.sessions.subscribe(REF, snapshot.cursor, event => { received.push(event); event.event.status = 'failed'; });
  assert.deepEqual(received.map(event => event.cursor.seq), [1]);
  const replay = []; const stopReplay = plugin.sessions.subscribe(REF, snapshot.cursor, event => replay.push(event));
  assert.equal(replay[0].event.status, 'idle'); stopReplay();
  await plugin.actions.invoke(invocation('sample.emit', '会话2'), origin);
  assert.deepEqual(received.map(event => event.cursor.seq), [1, 2]);
  assert.equal(received[0].event.type, 'pane_status');
  stop(); await plugin.actions.invoke(invocation('sample.emit', '会话3'), origin); assert.equal(received.length, 2);
  const atCut = []; const stopCut = plugin.sessions.subscribe(REF, (await plugin.sessions.snapshot(REF)).cursor, event => atCut.push(event));
  assert.deepEqual(atCut, []); stopCut();
});

test('持久表单按标识、版本和内容身份至多处理一次', async t => {
  const { plugin, removed } = await fixture(t);
  const pending = await plugin.forms.pending(); pending[0].title = '外部修改';
  assert.equal((await plugin.forms.pending())[0].title, '测试提问');
  assert.deepEqual(await plugin.forms.submit(submission('未知', { formId: 'missing' }), origin), { status: 'alreadyHandled' });
  assert.deepEqual(await plugin.forms.submit(submission('旧版', { revision: 0 }), origin), { status: 'alreadyHandled' });
  const results = await Promise.all(['首次', '并发', '重复'].map(key => plugin.forms.submit(submission(key), origin)));
  assert.deepEqual(results.map(result => result.status), ['accepted', 'alreadyHandled', 'alreadyHandled']);
  assert.deepEqual(await plugin.forms.submit(submission('首次'), origin), { status: 'alreadyHandled' });
  assert.equal((await plugin.forms.submit(submission('首次', { outcome: { status: 'cancelled' } }), origin)).status, 'idempotencyConflict');
  assert.deepEqual(await plugin.forms.pending(), []); assert.equal(plugin.inspection().submitted, 1);
  assert.deepEqual(removed, [{ id: 'question', reason: 'handled' }]);
});

test('业务取消只移除一次表单，动作表单不进入持久待办列表', async t => {
  const { plugin, removed, added } = await fixture(t);
  const catalog = plugin.actions.list();
  assert.deepEqual(catalog.map(action => action.id), ['sample.echo', 'sample.slow', 'sample.throw', 'sample.form', 'sample.presence', 'sample.emit']);
  assert.equal(catalog.find(action => action.id === 'sample.form').hasForm, true);
  const form = await plugin.actions.resolveForm('sample.form');
  assert.equal(form.id, 'action-form'); assert.equal(form.fields[0].id, 'message');
  assert.equal(await plugin.actions.resolveForm('sample.echo'), null);
  assert.deepEqual((await plugin.forms.pending()).map(item => item.id), ['question']); assert.equal(added.length, 1);
  assert.equal((await plugin.forms.submit(submission('取消', { outcome: { status: 'cancelled', reason: '拒绝' } }), origin)).status, 'accepted');
  assert.deepEqual(removed, [{ id: 'question', reason: 'cancelled' }]);
  assert.deepEqual(await plugin.forms.pending(), []);
  assert.equal((await plugin.actions.invoke({ ...invocation('sample.form', '动作表单', '内容'), formId: form.id, formRevision: form.revision }, origin)).status, 'ok');
});

test('动作按键和规范化内容记录身份，重放最终结果且隔离返回值', async t => {
  const { plugin } = await fixture(t);
  const inv = invocation('sample.echo', '回显', '你好');
  const result = await plugin.actions.invoke(inv, origin); assert.deepEqual(result, { status: 'ok', message: '你好' }); result.message = '外部修改';
  const reordered = { idempotencyKey: '回显', input: { fields: { message: '你好' }, answers: [] }, actionId: 'sample.echo' };
  assert.deepEqual(await plugin.actions.invoke(reordered, { ...origin, connectionId: '重连' }), { status: 'ok', message: '你好' });
  for (const changed of [{ ...inv, actionId: 'sample.form' }, { ...inv, target: { type: 'node', nodeId: CHILD } }, invocation('sample.echo', '回显', '不同内容'), { ...inv, formId: '表单', formRevision: 2 }]) {
    assert.equal((await plugin.actions.invoke(changed, origin)).status, 'idempotencyConflict');
  }
  assert.equal(plugin.inspection().invocations['sample.echo'], 1);
  await plugin.actions.invoke(invocation('sample.emit', '幂等事件'), origin);
  await plugin.actions.invoke(invocation('sample.emit', '幂等事件'), origin);
  assert.equal((await plugin.tree.snapshot(request)).revision, 2);
  assert.equal((await plugin.sessions.snapshot(REF)).cursor.seq, 1);
});

test('慢动作并发与调用端超时保留 pending，迟到结果成为最终结果', async t => {
  const { plugin } = await fixture(t);
  const inv = invocation('sample.slow', '慢动作', '调用时输入');
  const running = plugin.actions.invoke(inv, origin);
  assert.deepEqual(await plugin.actions.invoke(inv, origin), { status: 'pending' });
  assert.equal((await plugin.actions.invoke(invocation('sample.slow', '慢动作', '冲突'), origin)).status, 'idempotencyConflict');
  const timeoutMs = plugin.actions.list().find(action => action.id === 'sample.slow').timeoutMs;
  const timedOut = await Promise.race([running, delay(timeoutMs).then(() => ({ status: 'timeout' }))]);
  assert.deepEqual(timedOut, { status: 'timeout' });
  assert.deepEqual(await plugin.actions.invoke(inv, origin), { status: 'pending' });
  inv.input.fields.message = '调用后修改';
  assert.deepEqual(await running, { status: 'ok', message: '调用时输入' });
  assert.deepEqual(await plugin.actions.invoke(invocation('sample.slow', '慢动作', '调用时输入'), origin), { status: 'ok', message: '调用时输入' });
  assert.equal(plugin.inspection().invocations['sample.slow'], 1);
});

test('动作异常可观察且不重复执行，用户在场请求保留输入和来源', async t => {
  const { plugin, confirmations } = await fixture(t);
  const inv = invocation('sample.throw', '异常');
  await assert.rejects(plugin.actions.invoke(inv, origin), /示例动作异常/);
  await assert.rejects(plugin.actions.invoke(inv, origin), /示例动作异常/);
  assert.equal(plugin.inspection().invocations['sample.throw'], 1);
  const presence = invocation('sample.presence', '确认', '需要确认');
  assert.deepEqual(await plugin.actions.invoke(presence, origin), { status: 'ok', message: '需要确认' });
  assert.deepEqual(await plugin.actions.invoke(presence, origin), { status: 'ok', message: '需要确认' });
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0], { title: '确认测试动作', summary: '请确认示例动作的输入。', payload: { message: '需要确认' }, origin });
  await plugin.actions.invoke(invocation('sample.presence', '空输入'), origin);
  assert.deepEqual(confirmations[1].payload, {});
});

test('用户在场超时不缓存为最终失败，相同身份可重试', async t => {
  let count = 0;
  const { plugin, confirmations } = await fixture(t, async () => {
    if (++count === 1) throw Object.assign(new Error('用户确认超时'), { code: 'timeout' });
    return { deviceId: 'device-1', publicKey: '公钥', alg: 'ECDSA-P256-SHA256', signature: '签名' };
  });
  const inv = invocation('sample.presence', '重试确认');
  await assert.rejects(plugin.actions.invoke(inv, origin), error => error.code === 'timeout');
  assert.equal((await plugin.actions.invoke(invocation('sample.presence', '重试确认', '其他内容'), origin)).status, 'idempotencyConflict');
  assert.deepEqual(await plugin.actions.invoke(inv, origin), { status: 'ok' });
  assert.deepEqual(await plugin.actions.invoke(inv, origin), { status: 'ok' });
  assert.equal(confirmations.length, 2); assert.equal(plugin.inspection().invocations['sample.presence'], 2);
});
