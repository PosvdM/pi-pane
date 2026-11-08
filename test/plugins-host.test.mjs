import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PluginHost } from "../packages/server/dist/plugins/host.js";
import { AssetStore } from "../packages/server/dist/assets.js";

async function fixture(t, entries) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "pane-plugin-host-"))); const messages = []; const holds = new Map(); const listeners = new Set(); const directories = [];
  for (let i = 0; i < entries.length; i++) {
    const directory = path.join(home, "module-" + i); await mkdir(directory); directories.push(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", piPane: { entry: "./plugin.mjs", paneProtocol: [1, 1] } }));
    await writeFile(path.join(directory, "plugin.mjs"), entries[i]);
  }
  const host = new PluginHost({ home, plugins: directories, assets: new AssetStore(home), timeoutMs: 1000, emit: message => messages.push(message), mainSessions: source => ({
    list: () => [], get: () => undefined,
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    hold: (ref, reason) => { const key = Symbol(); holds.set(key, { source, ref, reason }); return () => holds.delete(key); },
  }) });
  t.after(async () => { await host.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); });
  await host.start();
  return { host, home, messages, holds, listeners, modules: await Promise.all(directories.map(directory => import(pathToFileURL(path.join(directory, "plugin.mjs")).href))) };
}
const node = (id, parentId = null, extra = {}) => ({ id, source: "sample", kind: "group", parentId, title: id, status: "idle", availability: "online", hasChildren: true, sortKey: id, revision: 1, capabilities: [], ...extra });

test("重复关闭共享同一清理屏障，不会在 deactivate 完成前返回", async t => {
  const f = await fixture(t, [`export let finish;const done=new Promise(resolve=>{finish=resolve});export const state={calls:0};export default function(){return{id:'sample',paneProtocol:[1,1],async activate(){},async deactivate(){state.calls++;await done}}}`]);
  const first = f.host.close(); const second = f.host.close(); assert.strictEqual(first, second);
  let completed = false; void second.then(() => { completed = true; }); await Promise.resolve(); assert.equal(completed, false);
  f.modules[0].finish(); await first; assert.equal(f.modules[0].state.calls, 1);
});

test("激活失败先使上下文失效，再释放 hold 与监听，持久横幅保留且临时横幅移除", async t => {
  const f = await fixture(t, [`export let context;
    export default function() { return {id:'sample',paneProtocol:[1,1],async activate(ctx){context=ctx;
      ctx.mainSessions.hold({source:'pane',id:'future'},'等待结果');ctx.mainSessions.onChange(()=>{});
      ctx.setBanner({id:'persistent',persistent:true,level:'warning',title:'持久'});
      ctx.setBanner({id:'temporary',level:'info',title:'临时'});throw new Error('激活故障');},async deactivate(){} }; }`]);
  assert.equal(f.host.runtime.list()[0].state, "failed"); assert.equal(f.holds.size, 0); assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.host.banners.list().map(banner => [banner.id, banner.sourceUnavailable]), [["persistent", true]]);
  assert.throws(() => f.modules[0].context.setBanner({ id: "late", title: "迟到", level: "info" }), error => error.code === "pluginUnavailable");
  assert.throws(() => f.modules[0].context.mainSessions.hold({ source: "pane", id: "late" }, "迟到"), error => error.code === "pluginUnavailable");
});

test("通知按来源去重，停用取消树与会话订阅并释放资源", async t => {
  const f = await fixture(t, `sample other`.split(" ").map(source => `export let context;export const state={treeOff:0,sessionOff:0};export default function(){return {id:'${source}',paneProtocol:[1,1],
    async activate(ctx){context=ctx;ctx.notify({source:'${source}',id:'same',title:'通知',level:'info'});ctx.notify({source:'${source}',id:'same',title:'重复',level:'info'});ctx.mainSessions.hold({source:'pane',id:'future'},'等待');},
    tree:{subscribe(){return()=>{state.treeOff++}}},sessions:{subscribe(){return()=>{state.sessionOff++}}}}}`));
  assert.equal(f.messages.filter(message => message.type === "notification").length, 2); assert.equal(f.holds.size, 2);
  assert.throws(() => f.modules[0].context.notify({ source: "other", id: "forged", title: "伪造来源", level: "info" }));
  const treeOff = f.host.treeSubscribe("sample", { epoch: "tree", revision: 0 }, () => {});
  const sessionOff = f.host.subscribe({ source: "sample", id: "child" }, { epoch: "stream", seq: 0 }, () => {});
  await f.host.runtime.stop("sample"); treeOff(); sessionOff();
  assert.equal(f.modules[0].state.treeOff, 1); assert.equal(f.modules[0].state.sessionOff, 1); assert.equal(f.holds.size, 1);
  assert.equal(f.host.runtime.get("other").id, "other");
});

test("树快照统一修正循环成员并移除未实现的能力，跨来源引用不能冒充", async t => {
  const nodes = [node("sample:a", "sample:b"), node("sample:b", "sample:a"), node("sample:child", "sample:a"), node("sample:session", null, { kind: "session", sessionRef: { source: "sample", id: "s" }, capabilities: ["open", "send", "abort", "subscribe", "action:missing", "future"] })];
  const f = await fixture(t, [`export const data=${JSON.stringify(nodes)};export default function(){return{id:'sample',paneProtocol:[1,1],async activate(){},tree:{async snapshot(){return{source:'sample',epoch:'e',revision:1,nodes:data}},async children(){return{epoch:'different',revision:1,nodes:data}}}}}`]);
  const snapshot = await f.host.treeSnapshot("sample", { openNodeIds: [], recentSince: new Date(0).toISOString() });
  assert.deepEqual(snapshot.nodes.slice(0, 2).map(node => node.parentId), ["pane:group:unassigned", "pane:group:unassigned"]);
  assert.equal(snapshot.nodes[2].parentId, "sample:a"); assert.deepEqual(snapshot.nodes[3].capabilities, []);
  assert.deepEqual(await f.host.treeChildren("sample", "sample:a", { epoch: "e", limit: 1 }), { reset: true, epoch: "different" });
  f.modules[0].data[0].source = "other";
  await assert.rejects(f.host.treeSnapshot("sample", { openNodeIds: [], recentSince: new Date(0).toISOString() }), error => error.code === "invalidPluginResult");
});

test("树和会话退订、重订及停用统一丢弃迟到回调，取消回调不能重入发送", async t => {
  const treeChange = { type: "upsert", revision: 100, node: node("sample:late") };
  const f = await fixture(t, [`export const trees=[],sessions=[],count={pending:0};export default function(){return{id:'sample',paneProtocol:[1,1],async activate(){},
    forms:{async pending(){count.pending++;return[]}},
    tree:{subscribe(after,emit){trees.push(emit);return()=>{emit(${JSON.stringify(treeChange)})}}},
    sessions:{subscribe(ref,after,emit){sessions.push(emit);return()=>{emit({ref:{source:'other',id:ref.id},cursor:after,event:{type:'late'}})}}}}}`]);
  const tree = [], sessions = []; const ref = { source: "sample", id: "child" }; const cursor = { epoch: "old", seq: 0 };
  const firstTree = f.host.treeSubscribe("sample", { epoch: "old", revision: 0 }, event => tree.push(event));
  const firstSession = f.host.subscribe(ref, cursor, event => sessions.push(event));
  f.modules[0].trees[0](treeChange); f.modules[0].sessions[0]({ ref, cursor, event: { type: "initial" } });
  assert.equal(tree.length, 1); assert.equal(sessions.length, 1);
  firstTree(); firstSession(); assert.equal(tree.length, 1); assert.equal(sessions.length, 1);
  f.host.treeSubscribe("sample", { epoch: "new", revision: 0 }, event => tree.push(event));
  f.host.subscribe(ref, { epoch: "new", seq: 0 }, event => sessions.push(event));
  f.modules[0].trees[0]({ type: "reset", epoch: "obsolete" }); f.modules[0].trees[0](treeChange);
  f.modules[0].sessions[0]({ ref: { source: "other", id: "child" }, cursor, event: { type: "invalid" } });
  await new Promise(setImmediate); assert.equal(f.modules[0].count.pending, 1);
  assert.equal(tree.length, 1); assert.equal(sessions.length, 1);
  f.modules[0].trees[1]({ ...treeChange, revision: 1 }); f.modules[0].sessions[1]({ ref, cursor: { epoch: "new", seq: 1 }, event: { type: "current" } });
  assert.equal(tree.length, 2); assert.equal(sessions.length, 2);
  await f.host.runtime.stop("sample");
  for (const emit of f.modules[0].trees) emit(treeChange);
  for (const emit of f.modules[0].sessions) emit({ ref, cursor, event: { type: "after-stop" } });
  assert.equal(tree.length, 2); assert.equal(sessions.length, 2);
});

test("自定义消息渲染器冲突时按配置顺序选择，不加载第三方前端代码", async t => {
  const f = await fixture(t, ["first", "second"].map(source => `export default function(){return{id:'${source}',paneProtocol:[1,1],async activate(){},renderers:{customMessages:[{customType:'shared',label:'${source}'}]}}}`));
  assert.equal((await f.host.catalog("first")).renderers[0].label, "first");
  assert.deepEqual((await f.host.catalog("second")).renderers, []);
  await f.host.runtime.stop("first");
  assert.equal((await f.host.catalog("second")).renderers[0].label, "second");
});

test("插件快照和实时事件在宿主提取图片，异常订阅不会传播到主会话", async t => {
  const f = await fixture(t, [`export let callback;export default function(){return{id:'sample',paneProtocol:[1,1],async activate(){},sessions:{
    async snapshot(ref){return{ref,cursor:{epoch:'e',seq:0},leafId:null,historyBefore:null,entries:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}],status:'idle',readonly:true}},
    async history(){return{entries:[],historyBefore:null}},subscribe(ref,after,emit){callback=emit;return()=>{}}}}}`]);
  const ref = { source: "sample", id: "s" }; const snapshot = await f.host.snapshot(ref);
  assert.match(snapshot.entries[0].blob, /^sha256-/); assert.equal(snapshot.entries[0].data, undefined);
  const events = []; f.host.subscribe(ref, snapshot.cursor, event => events.push(event));
  f.modules[0].callback({ ref: { source: "other", id: "s" }, cursor: { epoch: "e", seq: 1 }, event: { type: "pane_status", status: "idle" } });
  assert.equal(events[0].event.type, "resync");
  f.modules[0].callback({ ref, cursor: { epoch: "e", seq: 1 }, event: { type: "message_end", message: { type: "image", mimeType: "image/png", data: "aGVsbG8=" } } });
  assert.match(events[1].event.message.blob, /^sha256-/); assert.equal(events[1].event.message.data, undefined);
});
