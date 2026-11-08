import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { PluginRuntime } from "../packages/server/dist/plugins/runtime.js";
import { PaneError } from "../packages/server/dist/errors.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pane-runtime-")));
  const home = join(root, "home");
  const controls = new Map();
  const runtimes = [];
  const key = `pane-runtime-test-${root}`;
  globalThis[key] = controls;
  t.after(async () => {
    await Promise.all(runtimes.map(runtime => runtime.close()));
    delete globalThis[key];
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  let count = 0;
  async function plugin(id, options = {}) {
    const token = String(count++);
    const directory = options.directory ?? join(root, `plugin-${token}`);
    await mkdir(directory, { recursive: true });
    const control = { factories: 0, deactivations: 0, notifications: [], ...options.control };
    controls.set(token, control);
    const metadata = options.metadata ?? { entry: "./entry.mjs", paneProtocol: options.metadataProtocol ?? [1, 1] };
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: options.name ?? `plugin-${token}`, version: "1.2.3", type: "module", piPane: metadata, exports: "./entry.mjs" }));
    await writeFile(join(directory, "entry.mjs"), `
const control = globalThis[${JSON.stringify(key)}].get(${JSON.stringify(token)});
${options.topLevel ?? ""}
export default ${options.factory ?? `function createPlugin() {
  control.factories++;
  const plugin = {
    id: ${JSON.stringify(id)}, paneProtocol: ${JSON.stringify(options.protocol ?? [1, 1])},
    activate(ctx) { control.context = ctx; return control.activate?.(ctx); },
    deactivate() { control.deactivations++; return control.deactivate?.(); },
  };
  control.instance = plugin;
  return plugin;
}`}
`);
    return { directory, control };
  }
  function runtime(plugins, extra = {}) {
    const events = [], logs = [], contexts = new Map();
    const runtime = new PluginRuntime({
      home, plugins, timeoutMs: 600,
      log: Object.fromEntries(["info", "warn", "error"].map(level => [level, (...args) => logs.push([level, ...args])])),
      createContext(source, paneProtocol, dataDir, isCurrent) {
        const context = {
          paneProtocol, dataDir, isCurrent,
          notify(value) { if (isCurrent()) events.push(["notify", source, value]); },
        };
        assert.equal(isCurrent(), true);
        contexts.set(source, context);
        return context;
      },
      onActive(source) { events.push(["active", source, contexts.get(source)?.isCurrent()]); },
      onUnavailable(source) { events.push(["unavailable", source, contexts.get(source)?.isCurrent()]); },
      ...extra,
    });
    runtimes.push(runtime);
    return { runtime, events, logs, contexts };
  }
  return { root, home, plugin, runtime };
}

const unavailable = error => error instanceof PaneError && error.code === "pluginUnavailable";
const failed = error => error instanceof PaneError && error.code === "pluginFailed";
const timeout = error => error instanceof PaneError && error.code === "pluginTimeout";

test("加载目录插件、协商双重范围并在激活前创建私有上下文", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("sample", { metadataProtocol: [1, 3], protocol: [1, 2] });
  const loaded = f.runtime([relative(f.home, plugin.directory)]);
  const starting = loaded.runtime.start();
  assert.strictEqual(loaded.runtime.start(), starting);
  await starting;
  const [state] = loaded.runtime.list();
  assert.equal(state.state, "active");
  assert.equal(state.paneProtocol, 1);
  assert.strictEqual(loaded.runtime.get("sample"), plugin.control.instance);
  assert.equal(plugin.control.context.paneProtocol, 1);
  assert.equal(plugin.control.context.dataDir, join(f.home, "plugins", "sample"));
  assert.equal((await stat(plugin.control.context.dataDir)).isDirectory(), true);
  if (process.platform !== "win32") assert.equal((await stat(plugin.control.context.dataDir)).mode & 0o077, 0);
  assert.deepEqual(loaded.events, [["active", "sample", true]]);
  assert.equal(loaded.runtime.configured("sample"), true);
  assert.equal(loaded.runtime.configured("removed"), false);
  state.state = "failed";
  assert.equal(loaded.runtime.list()[0].state, "active");
  await loaded.runtime.close();
  assert.deepEqual(loaded.events.at(-1), ["unavailable", "sample", false]);
});

test("插件按照配置顺序完成加载，不并行激活后续来源", async t => {
  const f = await fixture(t); const entered = deferred(); const gate = deferred(); const order = [];
  const loaded = f.runtime(["first", "second"]);
  loaded.runtime.load = async entry => { order.push(entry.view.locator); if (entry.view.locator === "first") { entered.resolve(); await gate.promise; } };
  const starting = loaded.runtime.start(); await entered.promise;
  assert.deepEqual(order, ["first"]); gate.resolve(); await starting;
  assert.deepEqual(order, ["first", "second"]);
});

test("npm 包仅从服务端安装位置解析，启动项目的同名包不能覆盖", async t => {
  const f = await fixture(t); const scope = "pane-runtime-fixture-" + randomUUID(); const name = `@${scope}/plugin`;
  const directory = fileURLToPath(new URL(`../node_modules/@${scope}/plugin/`, import.meta.url));
  t.after(() => rm(fileURLToPath(new URL(`../node_modules/@${scope}/`, import.meta.url)), { recursive: true, force: true }));
  const plugin = await f.plugin("npm-source", { directory, name });
  const shadow = await f.plugin("shadow", { directory: join(f.root, "node_modules", `@${scope}`, "plugin"), name });
  const previous = process.cwd(); let loaded;
  process.chdir(f.root);
  try { loaded = f.runtime([name]); } finally { process.chdir(previous); }
  await loaded.runtime.start();
  assert.strictEqual(loaded.runtime.get("npm-source"), plugin.control.instance);
  assert.equal(shadow.control.factories, 0);
  const resolved = await realpath(directory);
  assert.ok(loaded.logs.some(log => log.some(value => String(value).includes(resolved) && String(value).includes("1.2.3"))));
});

test("只存在于启动项目的 npm 插件不会作为回退加载", async t => {
  const f = await fixture(t); const name = "pane-cwd-only-" + randomUUID();
  const shadow = await f.plugin("shadow", { directory: join(f.root, "node_modules", name), name });
  const previous = process.cwd(); let loaded; process.chdir(f.root);
  try { loaded = f.runtime([name]); } finally { process.chdir(previous); }
  await loaded.runtime.start();
  assert.equal(loaded.runtime.list()[0].state, "failed"); assert.equal(shadow.control.factories, 0);
});

test("相对本地路径以配置目录为基准，与启动 cwd 无关", async t => {
  const f = await fixture(t); const project = join(f.root, "project");
  const trusted = await f.plugin("local", { directory: join(f.home, "trusted") });
  const shadow = await f.plugin("shadow", { directory: join(project, "trusted") });
  const previous = process.cwd(); let loaded; process.chdir(project);
  try { loaded = f.runtime(["./trusted"]); } finally { process.chdir(previous); }
  await loaded.runtime.start(); assert.strictEqual(loaded.runtime.get("local"), trusted.control.instance);
  assert.equal(shadow.control.factories, 0);
});

test("元数据和实例范围必须同时支持协议 1", async t => {
  const f = await fixture(t);
  const metadata = await f.plugin("metadata", { metadataProtocol: [2, 4] });
  const instance = await f.plugin("instance", { protocol: [2, 4] });
  const invalid = await f.plugin("invalid", { protocol: [0, 1] });
  const healthy = await f.plugin("healthy");
  const loaded = f.runtime([metadata.directory, instance.directory, invalid.directory, healthy.directory]);
  await loaded.runtime.start();
  assert.deepEqual(loaded.runtime.list().map(item => item.state), ["failed", "failed", "failed", "active"]);
  assert.equal(metadata.control.factories, 0);
  assert.equal(instance.control.deactivations, 1);
  assert.equal(invalid.control.deactivations, 1);
  assert.equal(loaded.contexts.has("instance"), false);
  const saved = JSON.parse(await readFile(join(f.home, "runtime-sources.json"), "utf8"));
  assert.equal(saved[instance.directory], "instance");
  assert.equal(saved[healthy.directory], "healthy");
});

test("拒绝保留 id、目录穿越和跨平台危险路径", async t => {
  const f = await fixture(t);
  const ids = ["pane", "Pane", "MixedCase", "..", "../escape", "a/b", "a\\b", "C:drive", "con", "trailing.", "", "-start", "_start", "a..b", "a.con", "com9.feature", "safe.pane", "a".repeat(65)];
  const plugins = await Promise.all(ids.map(id => f.plugin(id)));
  const healthy = await f.plugin("a".repeat(64));
  const loaded = f.runtime([...plugins.map(plugin => plugin.directory), healthy.directory]);
  await loaded.runtime.start();
  assert.ok(loaded.runtime.list().slice(0, -1).every(state => state.state === "failed"));
  assert.equal(loaded.runtime.list().at(-1).state, "active");
  assert.ok(loaded.logs.some(log => log[0] === "error"));
  assert.equal(loaded.contexts.size, 1);
  assert.ok(plugins.every(plugin => plugin.control.deactivations === 0));
});

test("重复 id 拒绝且不使有效实例不可用", async t => {
  const f = await fixture(t);
  const first = await f.plugin("duplicate");
  const second = await f.plugin("duplicate");
  const loaded = f.runtime([first.directory, second.directory]);
  await loaded.runtime.start();
  assert.deepEqual(loaded.runtime.list().map(state => state.state).sort(), ["active", "failed"]);
  assert.match(loaded.runtime.list().find(state => state.state === "failed").error, /重复/);
  assert.equal(loaded.events.filter(event => event[0] === "unavailable").length, 0);
  assert.ok(loaded.runtime.get("duplicate"));
  await loaded.runtime.stop("duplicate");
  await loaded.runtime.close();
  assert.equal(first.control.deactivations + second.control.deactivations, 1);
  assert.equal(loaded.events.filter(event => event[0] === "unavailable").length, 1);
});

test("工厂和入口失败不会阻断其他插件", async t => {
  const f = await fixture(t);
  const throwing = await f.plugin("throwing", { factory: "function() { throw new Error('factory-error'); }" });
  const asynchronous = await f.plugin("async", { factory: "async function() { throw new Error('async-factory-error'); }" });
  const badEntry = await f.plugin("escape", { metadata: { entry: "../outside.mjs", paneProtocol: [1, 1] } });
  const healthy = await f.plugin("healthy");
  const loaded = f.runtime([throwing.directory, asynchronous.directory, badEntry.directory, healthy.directory]);
  await loaded.runtime.start();
  assert.deepEqual(loaded.runtime.list().map(state => state.state), ["failed", "failed", "failed", "active"]);
  assert.ok(loaded.logs.some(log => log.some(item => String(item).includes("factory-error"))));
  assert.ok(loaded.logs.some(log => log.some(item => String(item).includes("async-factory-error"))));
});

test("只读调用隔离同步异常、异步拒绝和超时，超时后插件仍可读", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("readable");
  const loaded = f.runtime([plugin.directory]);
  await loaded.runtime.start();
  assert.equal(await loaded.runtime.call("readable", "sync", () => 7), 7);
  assert.equal(await loaded.runtime.call("readable", "async", async () => 8), 8);
  await assert.rejects(loaded.runtime.call("readable", "throw", () => { throw new Error("sync-error"); }), failed);
  await assert.rejects(loaded.runtime.call("readable", "reject", async () => { throw new Error("async-error"); }), failed);
  await assert.rejects(loaded.runtime.call("readable", "undefined", () => { throw undefined; }), failed);
  const late = deferred();
  await assert.rejects(loaded.runtime.call("readable", "timeout", () => late.promise, 15), timeout);
  late.reject(new Error("late-error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(loaded.logs.some(log => log.some(item => String(item).includes("late-error"))));
  assert.strictEqual(loaded.runtime.get("readable"), plugin.control.instance);
  await assert.rejects(loaded.runtime.call("absent", "missing", () => 0), unavailable);
});

test("activate 同步抛错和异步拒绝先 fence 再清理", async t => {
  const f = await fixture(t);
  for (const asynchronous of [false, true]) {
    let currentDuringCleanup;
    const plugin = await f.plugin(`broken-${asynchronous}`, { control: {
      activate() { return asynchronous ? Promise.reject(new Error("activate-error")) : (() => { throw new Error("activate-error"); })(); },
      deactivate() { currentDuringCleanup = plugin.control.context.isCurrent(); },
    } });
    const loaded = f.runtime([plugin.directory]);
    await loaded.runtime.start();
    assert.equal(loaded.runtime.list()[0].state, "failed");
    assert.equal(currentDuringCleanup, false);
    assert.deepEqual(loaded.events, [["unavailable", `broken-${asynchronous}`, false]]);
    assert.equal(plugin.control.deactivations, 1);
    assert.throws(() => loaded.runtime.get(`broken-${asynchronous}`), unavailable);
    await loaded.runtime.close();
    assert.equal(plugin.control.deactivations, 1);
  }
});

test("activate 超时的迟到完成不能恢复上下文，清理也有界", async t => {
  const f = await fixture(t);
  const activation = deferred();
  const entered = deferred();
  const plugin = await f.plugin("slow", { control: {
    activate() { entered.resolve(); return activation.promise.then(() => plugin.control.context.notify("late")); },
    deactivate() { return new Promise(() => {}); },
  } });
  const loaded = f.runtime([plugin.directory], { timeoutMs: 150 });
  const starting = loaded.runtime.start();
  await entered.promise;
  await starting;
  assert.equal(loaded.runtime.list()[0].state, "failed");
  assert.match(loaded.runtime.list()[0].error, /超时/);
  assert.equal(plugin.control.context.isCurrent(), false);
  assert.equal(plugin.control.deactivations, 1);
  activation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.runtime.list()[0].state, "failed");
  assert.deepEqual(loaded.events, [["unavailable", "slow", false]]);
  await loaded.runtime.close();
  assert.equal(plugin.control.deactivations, 1);
});

test("stop 立即取消 loading 和在途只读调用，重复关闭只清理一次", async t => {
  const f = await fixture(t);
  const entered = deferred(), activation = deferred();
  const plugin = await f.plugin("loading", { control: {
    activate() { entered.resolve(); return activation.promise; },
  } });
  const loaded = f.runtime([plugin.directory]);
  const starting = loaded.runtime.start();
  await entered.promise;
  const stopping = loaded.runtime.stop("loading");
  assert.equal(plugin.control.context.isCurrent(), false);
  await Promise.all([starting, stopping, loaded.runtime.stop("loading")]);
  activation.resolve();
  assert.equal(loaded.runtime.list()[0].state, "disabled");
  assert.equal(plugin.control.deactivations, 1);
  assert.equal(loaded.events.filter(event => event[0] === "active").length, 0);

  const second = await f.plugin("active");
  const active = f.runtime([second.directory]);
  await active.runtime.start();
  const read = active.runtime.call("active", "pending", () => new Promise(() => {}));
  const rejected = assert.rejects(read, unavailable);
  const closing = active.runtime.close();
  assert.strictEqual(active.runtime.close(), closing);
  assert.equal(second.control.context.isCurrent(), false);
  await Promise.all([closing, rejected]);
  assert.equal(second.control.deactivations, 1);
  await active.runtime.start();
  assert.throws(() => active.runtime.get("active"), unavailable);
});

test("工厂与关闭的微任务竞争仍会清理已创建实例", async t => {
  const f = await fixture(t);
  let loaded;
  const plugin = await f.plugin("factory-close", {
    factory: `function() {
      const plugin = { id: 'factory-close', paneProtocol: [1, 1], async activate() {}, async deactivate() { control.deactivations++; } };
      queueMicrotask(() => control.close());
      return plugin;
    }`,
    control: { close() { return loaded.runtime.close(); } },
  });
  loaded = f.runtime([plugin.directory]);
  await loaded.runtime.start();
  await loaded.runtime.close();
  assert.equal(plugin.control.deactivations, 1);
  assert.equal(loaded.runtime.list()[0].state, "disabled");
});

test("挂起入口导入有界，关闭后迟到模块不会调用工厂", async t => {
  const f = await fixture(t);
  const imported = deferred(), release = deferred();
  const plugin = await f.plugin("late-import", {
    topLevel: "control.imported.resolve(); await control.release.promise;",
    control: { imported, release },
  });
  const loaded = f.runtime([plugin.directory], { timeoutMs: 150 });
  const starting = loaded.runtime.start();
  await imported.promise;
  await starting;
  assert.equal(loaded.runtime.list()[0].state, "failed");
  await loaded.runtime.close();
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(plugin.control.factories, 0);
});

test("重启从持久映射识别导入失败的已配置来源，移除后不再配置", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("retained");
  const removed = await f.plugin("removed");
  const first = f.runtime([plugin.directory, removed.directory]);
  await first.runtime.start();
  await first.runtime.close();
  await rm(join(plugin.directory, "package.json"));
  const restarted = f.runtime([plugin.directory]);
  await restarted.runtime.start();
  assert.deepEqual(restarted.runtime.list().map(({ source, state }) => ({ source, state })), [{ source: "retained", state: "failed" }]);
  assert.equal(restarted.runtime.configured("retained"), true);
  assert.equal(restarted.runtime.configured("removed"), false);
  assert.deepEqual(restarted.events, [["unavailable", "retained", undefined]]);
  const empty = f.runtime([]);
  await empty.runtime.start();
  assert.equal(empty.runtime.configured("retained"), false);
  assert.ok(!(await readdir(f.home)).some(name => name.endsWith(".tmp")));
});

test("初始化失败来源也能在下次导入失败时识别", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("failed-source", { control: { activate() { throw new Error("failure"); } } });
  const first = f.runtime([plugin.directory]);
  await first.runtime.start();
  await first.runtime.close();
  await rm(plugin.directory, { recursive: true });
  const second = f.runtime([plugin.directory]);
  await second.runtime.start();
  assert.equal(second.runtime.configured("failed-source"), true);
  assert.equal(second.runtime.configured("other"), false);
  assert.equal(second.runtime.list()[0].source, "failed-source");
});

test("未知失败定位符及损坏来源文件保守保留来源", async t => {
  const f = await fixture(t);
  const known = await f.plugin("known");
  const first = f.runtime([known.directory]);
  await first.runtime.start();
  await first.runtime.close();
  const missing = join(f.root, "unrecognized");
  const unknown = f.runtime([known.directory, missing]);
  await unknown.runtime.start();
  assert.equal(unknown.runtime.configured("legacy"), true);
  assert.equal(unknown.runtime.configured("known"), true);
  await unknown.runtime.close();
  await writeFile(join(f.home, "runtime-sources.json"), "{ broken");
  const corrupt = f.runtime([missing]);
  await corrupt.runtime.start();
  assert.equal(corrupt.runtime.configured("legacy"), true);
  assert.ok(corrupt.logs.some(log => log[0] === "warn"));
});

test("宿主回调或日志抛错不阻断生命周期", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("host-callback");
  const loaded = f.runtime([plugin.directory], {
    onActive() { throw new Error("callback"); },
    onUnavailable() { throw new Error("callback"); },
    log: { info() { throw new Error("logger"); }, warn() { throw new Error("logger"); }, error() { throw new Error("logger"); } },
  });
  await loaded.runtime.start();
  assert.ok(loaded.runtime.get("host-callback"));
  await loaded.runtime.close();
  assert.equal(plugin.control.deactivations, 1);
});

test("同一定位符识别到新的来源后覆盖旧映射", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("replacement");
  await mkdir(f.home);
  await writeFile(join(f.home, "runtime-sources.json"), JSON.stringify({ [plugin.directory]: "old-source" }));
  const loaded = f.runtime([plugin.directory]);
  await loaded.runtime.start();
  assert.equal(loaded.runtime.configured("replacement"), true);
  assert.equal(loaded.runtime.configured("old-source"), false);
  assert.equal(JSON.parse(await readFile(join(f.home, "runtime-sources.json"), "utf8"))[plugin.directory], "replacement");
});

test("deactivate 抛错或拒绝不会使关闭失败，也不重复调用", async t => {
  const f = await fixture(t);
  for (const asynchronous of [false, true]) {
    const plugin = await f.plugin(`cleanup-${asynchronous}`, { control: {
      deactivate() { if (asynchronous) return Promise.reject(new Error("cleanup-error")); throw new Error("cleanup-error"); },
    } });
    const loaded = f.runtime([plugin.directory]);
    await loaded.runtime.start();
    await Promise.all([loaded.runtime.stop(`cleanup-${asynchronous}`), loaded.runtime.close()]);
    await loaded.runtime.close();
    assert.equal(plugin.control.deactivations, 1);
    assert.ok(loaded.logs.some(log => log.some(item => String(item).includes("cleanup-error"))));
  }
});

test("关闭正在激活的插件不等待激活完成", async t => {
  const f = await fixture(t);
  const entered = deferred();
  const plugin = await f.plugin("close-loading", { control: {
    activate() { entered.resolve(); return new Promise(() => {}); },
  } });
  const loaded = f.runtime([plugin.directory]);
  const starting = loaded.runtime.start();
  await entered.promise;
  const closing = loaded.runtime.close();
  assert.equal(plugin.control.context.isCurrent(), false);
  await Promise.all([starting, closing]);
  assert.equal(plugin.control.deactivations, 1);
  assert.equal(loaded.runtime.list()[0].state, "disabled");
});

test("close 在 start 前执行时不会加载插件", async t => {
  const f = await fixture(t);
  const plugin = await f.plugin("not-started");
  const loaded = f.runtime([plugin.directory]);
  await loaded.runtime.close();
  await loaded.runtime.start();
  assert.equal(plugin.control.factories, 0);
  assert.equal(loaded.runtime.list()[0].state, "disabled");
});
