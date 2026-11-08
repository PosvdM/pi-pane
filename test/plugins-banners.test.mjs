import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BannerStore } from "../packages/server/dist/plugins/banners.js";

const origin = { client: "browser", connectionId: "tab-42", receivedAt: "2026-01-01T00:00:00.000Z" };
const banner = (id, extra = {}) => ({ id, level: "info", title: `横幅 ${id}`, ...extra });

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(join(tmpdir(), "pane-banners-"));
  const events = [];
  const configured = new Set(options.sources ?? ["alpha", "beta"]);
  const store = new BannerStore(home, message => events.push(message), source => configured.has(source), options.log);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, file: join(home, "banners.json"), events, configured, store };
}

function restart(f) {
  f.store.close();
  const store = new BannerStore(f.home, message => f.events.push(message), source => f.configured.has(source));
  store.load();
  return store;
}

function fault(t, name, implementation) {
  const mocked = t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}

function errorCode(code) {
  return error => error.code === code;
}

test("持久横幅同步落盘，重启只加载持久横幅并标记来源不可用", t => {
  const f = fixture(t);
  f.store.load();
  f.store.set("alpha", banner("saved", { persistent: true, body: "处理说明", actions: ["retry"] }));
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.banners[0].source, "alpha");
  assert.equal(saved.banners[0].persistent, true);
  assert.equal("sourceUnavailable" in saved.banners[0], false);
  f.store.set("alpha", banner("temporary"));
  f.store.set("beta", banner("saved", { level: "error", persistent: true }));
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).banners.length, 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const restored = restart(f);
  assert.deepEqual(restored.list().map(b => [b.source, b.id, b.sourceUnavailable]), [
    ["beta", "saved", true], ["alpha", "saved", true],
  ]);
  assert.deepEqual(restored.own("alpha"), [banner("saved", { persistent: true, body: "处理说明", actions: ["retry"] })]);
  restored.close();
});

test("非持久横幅不会创建存储目录，持久与非持久替换会更新磁盘", t => {
  const f = fixture(t);
  const home = join(f.home, "nested");
  const store = new BannerStore(home, () => {}, () => true);
  store.set("alpha", banner("ephemeral"));
  store.clear("alpha", "ephemeral");
  assert.equal(fs.existsSync(home), false);
  f.store.set("alpha", banner("switch", { persistent: true }));
  f.store.set("alpha", banner("switch", { persistent: false }));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")).banners, []);
  assert.equal(restart(f).list().length, 0);
  f.store.set("alpha", banner("switch", { persistent: true }));
  assert.equal(restart(f).list().length, 1);
  f.store.clear("alpha", "switch");
  assert.deepEqual(restart(f).list(), []);
});

test("严重程度优先，同级横幅按首次设置次序稳定排列，重启保留次序", t => {
  const f = fixture(t);
  for (const [source, id, level] of [
    ["alpha", "first", "info"], ["beta", "second", "info"],
    ["alpha", "warning", "warning"], ["beta", "error", "error"],
  ]) f.store.set(source, banner(id, { level, persistent: true }));
  f.store.set("alpha", banner("first", { title: "替换", persistent: true }));
  assert.deepEqual(f.store.list().map(b => b.id), ["error", "warning", "first", "second"]);
  assert.deepEqual(restart(f).list().map(b => b.id), ["error", "warning", "first", "second"]);
  f.store.set("beta", banner("second", { level: "warning", persistent: true }));
  assert.deepEqual(f.store.list().map(b => b.id), ["error", "second", "warning", "first"]);
  f.store.clear("alpha", "first");
  f.store.set("alpha", banner("first", { persistent: true }));
  f.store.set("beta", banner("second", { persistent: true }));
  assert.deepEqual(f.store.list().map(b => b.id), ["error", "warning", "second", "first"]);
});

test("加载失败或停用保留持久横幅、清除临时横幅，不影响其他来源", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("persistent", { persistent: true }));
  f.store.set("alpha", banner("temporary"));
  f.store.set("beta", banner("temporary"));
  const disk = fs.readFileSync(f.file, "utf8");
  f.events.length = 0;
  f.store.availability("alpha", false);
  assert.deepEqual(f.store.own("alpha"), [banner("persistent", { persistent: true })]);
  assert.equal(f.store.list().find(b => b.source === "alpha").sourceUnavailable, true);
  assert.equal(f.store.list().find(b => b.source === "beta").sourceUnavailable, false);
  assert.deepEqual(f.events, [
    { type: "bannerCleared", source: "alpha", id: "temporary" },
    { type: "banner", banner: { ...banner("persistent", { persistent: true }), source: "alpha", sourceUnavailable: true } },
  ]);
  assert.equal(fs.readFileSync(f.file, "utf8"), disk);
  assert.deepEqual(f.store.removable(), []);
  f.events.length = 0;
  f.store.availability("alpha", false);
  assert.deepEqual(f.events, []);
  f.store.availability("never-loaded", false);
  assert.equal(f.store.list().length, 2);
});

test("来源恢复后 listBanners 能找到旧横幅，广播可用状态并允许显式清除", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("saved", { persistent: true }));
  const restored = restart(f);
  assert.deepEqual(restored.own("alpha"), [banner("saved", { persistent: true })]);
  f.events.length = 0;
  restored.availability("alpha", true);
  assert.deepEqual(f.events, [{ type: "banner", banner: { ...banner("saved", { persistent: true }), source: "alpha", sourceUnavailable: false } }]);
  assert.equal(restored.list()[0].sourceUnavailable, false);
  restored.clear("alpha", "saved");
  assert.deepEqual(restored.own("alpha"), []);
  assert.deepEqual(restart(f).list(), []);
  restored.close();
});

test("来源隔离忽略伪造字段，输入、查询与广播均无可变引用泄漏", t => {
  const f = fixture(t);
  const input = banner("shared", { persistent: true, actions: ["retry"], source: "beta", sourceUnavailable: true, extra: { ignored: true } });
  f.store.set("alpha", input);
  f.store.set("beta", banner("shared"));
  input.actions.push("tampered");
  input.title = "篡改";
  const own = f.store.own("alpha");
  const list = f.store.list();
  own[0].actions.push("tampered-own");
  own[0].title = "篡改";
  list[0].actions.push("tampered-list");
  f.events[0].banner.actions.push("tampered-event");
  assert.deepEqual(f.store.own("alpha"), [banner("shared", { persistent: true, actions: ["retry"] })]);
  assert.equal(f.store.list()[0].source, "alpha");
  assert.equal(f.store.list()[0].sourceUnavailable, false);
  assert.equal("source" in own[0], false);
  assert.equal("extra" in f.store.list()[0], false);
  f.store.clear("beta", "shared");
  assert.equal(f.store.own("alpha").length, 1);
  assert.equal(f.store.own("beta").length, 0);
  f.store.clear("beta", "absent");
  assert.equal(f.store.list().length, 1);
});

test("已配置但不可用的横幅禁止清除，配置移除后仍需二次确认", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("saved", { persistent: true }));
  f.store.set("alpha", banner("temporary"));
  f.store.availability("alpha", false);
  assert.throws(() => f.store.removeOrphan("alpha", "saved", origin, true), errorCode("sourceConfigured"));
  f.configured.delete("alpha");
  const removable = f.store.removable();
  assert.deepEqual(removable.map(b => b.id), ["saved"]);
  removable[0].title = "篡改";
  for (const confirmed of [false, undefined, "true", 1]) {
    assert.throws(() => f.store.removeOrphan("alpha", "saved", origin, confirmed), errorCode("confirmationRequired"));
  }
  assert.equal(fs.existsSync(join(f.home, "plugin-audit.jsonl")), false);
  assert.equal(f.store.list()[0].title, "横幅 saved");
  f.store.removeOrphan("alpha", "saved", origin, true);
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual(restart(f).list(), []);
  const audit = fs.readFileSync(join(f.home, "plugin-audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].connectionId, origin.connectionId);
  assert.ok(Number.isFinite(Date.parse(audit[0].at)));
  assert.equal(audit[0].source, "alpha");
  assert.equal(audit[0].id, "saved");
  assert.deepEqual(audit[0].banner, { ...banner("saved", { persistent: true }), source: "alpha", sourceUnavailable: true });
  assert.equal(f.events.at(-1).type, "bannerCleared");
});

test("removable 只返回配置已移除的持久横幅，不要求来源已标为不可用", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("saved", { persistent: true, actions: ["retry"] }));
  f.store.set("alpha", banner("temporary"));
  f.store.set("beta", banner("saved", { persistent: true }));
  f.configured.delete("alpha");
  const removable = f.store.removable();
  assert.deepEqual(removable.map(b => [b.source, b.id]), [["alpha", "saved"]]);
  removable[0].actions.push("tampered");
  assert.deepEqual(f.store.own("alpha")[0].actions, ["retry"]);
  assert.throws(() => f.store.removeOrphan("alpha", "temporary", origin, true), errorCode("bannerNotFound"));
  assert.throws(() => f.store.removeOrphan("alpha", "absent", origin, true), errorCode("bannerNotFound"));
  assert.throws(() => f.store.removeOrphan("alpha", "saved", { client: "browser", connectionId: "" }, true), errorCode("invalidOrigin"));
});

test("注入审计先于删除同步调用，审计抛错不得删除或广播", t => {
  let fail = true;
  const records = [];
  const f = fixture(t, { sources: [], log: record => {
    assert.equal(f.store.list().length, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).banners.length, 1);
    records.push(record);
    record.banner.actions.push("audit-only");
    if (fail) throw new Error("审计失败");
  } });
  f.store.set("alpha", banner("saved", { persistent: true, actions: ["retry"] }));
  const disk = fs.readFileSync(f.file, "utf8");
  f.events.length = 0;
  assert.throws(() => f.store.removeOrphan("alpha", "saved", origin, true), /审计失败/);
  assert.equal(fs.readFileSync(f.file, "utf8"), disk);
  assert.deepEqual(f.store.own("alpha")[0].actions, ["retry"]);
  assert.deepEqual(f.events, []);
  fail = false;
  f.store.removeOrphan("alpha", "saved", origin, true);
  assert.equal(records.length, 2);
  assert.equal(records[0].connectionId, "tab-42");
  assert.deepEqual(f.store.list(), []);
});

test("默认审计写失败时保留横幅和持久文件", t => {
  const f = fixture(t, { sources: [] });
  f.store.set("alpha", banner("saved", { persistent: true }));
  fs.mkdirSync(join(f.home, "plugin-audit.jsonl"));
  const disk = fs.readFileSync(f.file, "utf8");
  f.events.length = 0;
  assert.throws(() => f.store.removeOrphan("alpha", "saved", origin, true));
  assert.equal(fs.readFileSync(f.file, "utf8"), disk);
  assert.equal(f.store.list().length, 1);
  assert.deepEqual(f.events, []);
});

test("校验已知横幅字段，错误输入不改变内存、持久文件或广播", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("saved", { persistent: true }));
  const before = f.store.list();
  const disk = fs.readFileSync(f.file, "utf8");
  f.events.length = 0;
  const invalid = [null, [], {}, banner(""), banner("   "), banner("x", { id: 1 }),
    banner("x", { level: "fatal" }), banner("x", { level: "toString" }),
    banner("x", { title: 4 }), banner("x", { title: " " }),
    banner("x", { persistent: "true" }), banner("x", { persistent: null }),
    banner("x", { body: 1 }), banner("x", { actions: "retry" }),
    banner("x", { actions: ["ok", 2] }), banner("x", { actions: [""] }), banner("x", { actions: Array(1) })];
  for (const value of invalid) assert.throws(() => f.store.set("alpha", value), errorCode("invalidBanner"));
  for (const source of ["", " ", null, 4]) assert.throws(() => f.store.set(source, banner("x")), errorCode("invalidBanner"));
  assert.deepEqual(f.store.list(), before);
  assert.equal(fs.readFileSync(f.file, "utf8"), disk);
  assert.deepEqual(f.events, []);
});

test("损坏、无效或重复的持久记录明确报错，加载失败保留现有状态", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("memory"));
  const before = f.store.list();
  for (const text of ["{", "null", "[]", JSON.stringify({ version: 2, banners: [] }),
    JSON.stringify({ version: 1, banners: [null] }),
    JSON.stringify({ version: 1, banners: [{ ...banner("saved", { persistent: true }), source: "" }] }),
    JSON.stringify({ version: 1, banners: [{ ...banner("saved", { persistent: true }), source: "alpha", level: "bad" }] }),
    JSON.stringify({ version: 1, banners: Array(2).fill({ ...banner("saved", { persistent: true }), source: "alpha" }) }),
  ]) {
    fs.writeFileSync(f.file, text);
    assert.throws(() => f.store.load(), error => error.code === "invalidBannerFile" && error.message.includes("banners.json"));
    assert.deepEqual(f.store.list(), before);
    assert.equal(fs.readFileSync(f.file, "utf8"), text);
  }
});

test("load 忽略非持久记录及未知字段，读取权限等 I/O 错误不被当作空文件", t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, banners: [
    { ...banner("skip"), source: "alpha" },
    { ...banner("saved", { persistent: true }), source: "alpha", sourceUnavailable: false, extra: "ignored" },
  ] }));
  f.store.load();
  assert.deepEqual(f.store.list(), [{ ...banner("saved", { persistent: true }), source: "alpha", sourceUnavailable: true }]);
  const before = f.store.list();
  const realRead = fs.readFileSync;
  fault(t, "readFileSync", function (path, ...args) {
    if (path === f.file) throw Object.assign(new Error("读取失败"), { code: "EACCES" });
    return realRead.call(this, path, ...args);
  });
  assert.throws(() => f.store.load(), errorCode("EACCES"));
  assert.deepEqual(f.store.list(), before);
});

test("写临时文件失败时不新增横幅、不改变内存或广播，并清理临时文件", t => {
  const f = fixture(t);
  f.store.set("alpha", banner("saved", { persistent: true }));
  const before = f.store.list();
  const disk = fs.readFileSync(f.file, "utf8");
  f.events.length = 0;
  fault(t, "writeFileSync", () => { throw Object.assign(new Error("磁盘已满"), { code: "ENOSPC" }); });
  assert.throws(() => f.store.set("alpha", banner("new", { persistent: true })), errorCode("ENOSPC"));
  assert.deepEqual(f.store.list(), before);
  assert.equal(fs.readFileSync(f.file, "utf8"), disk);
  assert.deepEqual(f.events, []);
  assert.deepEqual(fs.readdirSync(f.home), ["banners.json"]);
});

test("原子替换失败时所有持久变更保持内存与旧文件一致", t => {
  const f = fixture(t, { sources: [], log: () => {} });
  f.store.set("alpha", banner("saved", { persistent: true }));
  f.store.set("alpha", banner("temporary"));
  const before = f.store.list();
  const disk = fs.readFileSync(f.file, "utf8");
  f.events.length = 0;
  const mocked = fault(t, "renameSync", (temporary, target) => {
    assert.equal(target, f.file);
    assert.ok(temporary.startsWith(`${f.file}.`));
    assert.ok(temporary.endsWith(".tmp"));
    assert.equal(fs.readFileSync(f.file, "utf8"), disk);
    assert.equal(JSON.parse(fs.readFileSync(temporary, "utf8")).version, 1);
    if (process.platform !== "win32") assert.equal(fs.statSync(temporary).mode & 0o777, 0o600);
    throw Object.assign(new Error("原子替换失败"), { code: "EACCES" });
  });
  for (const operation of [
    () => f.store.set("alpha", banner("saved", { title: "替换", persistent: true })),
    () => f.store.set("alpha", banner("saved")),
    () => f.store.set("alpha", banner("temporary", { persistent: true })),
    () => f.store.clear("alpha", "saved"),
    () => f.store.removeOrphan("alpha", "saved", origin, true),
  ]) {
    assert.throws(operation, errorCode("EACCES"));
    assert.deepEqual(f.store.list(), before);
    assert.equal(fs.readFileSync(f.file, "utf8"), disk);
    assert.deepEqual(f.events, []);
    assert.deepEqual(fs.readdirSync(f.home), ["banners.json"]);
  }
  assert.equal(mocked.mock.callCount(), 5);
});

test("广播发生前持久状态已原子替换，广播接收方能同步读取", t => {
  const f = fixture(t);
  const observed = [];
  const store = new BannerStore(f.home, message => {
    const persisted = JSON.parse(fs.readFileSync(f.file, "utf8")).banners;
    if (message.type === "banner") {
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].title, message.banner.title);
      observed.push(message.banner.title);
    } else {
      assert.deepEqual(persisted, []);
      observed.push("cleared");
    }
  }, () => true);
  store.set("alpha", banner("saved", { persistent: true }));
  store.set("alpha", banner("saved", { title: "替换内容", persistent: true }));
  store.clear("alpha", "saved");
  assert.deepEqual(observed, ["横幅 saved", "替换内容", "cleared"]);
});

test("存储目录创建失败时不发布横幅，close 返回前无在途写入", t => {
  const f = fixture(t);
  const blocked = join(f.home, "blocked");
  fs.writeFileSync(blocked, "not a directory");
  const store = new BannerStore(blocked, () => assert.fail("写失败不得广播"), () => true);
  assert.throws(() => store.set("alpha", banner("saved", { persistent: true })));
  assert.deepEqual(store.list(), []);
  f.store.set("alpha", banner("saved", { persistent: true }));
  f.store.close();
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).banners.length, 1);
});
