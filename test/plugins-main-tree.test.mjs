import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MainTree } from "../packages/server/dist/plugins/main-tree.js";

const recentSince = "2025-01-01T00:00:00.000Z";
const request = (openNodeIds = []) => ({ openNodeIds, recentSince });
const cursor = ({ epoch, revision }) => ({ epoch, revision });
const nodeId = (id) => `pane:session:${id}`;
function row(id, extra = {}) {
  const { info = {}, ...details } = extra;
  return {
    info: { ref: { source: "pane", id }, nodeId: nodeId(id), cwd: path.resolve("tree-project"),
      sessionFile: path.resolve(`${id}.jsonl`), title: id, hosted: false, status: "idle", ...info },
    ...details,
  };
}
function fakeDirectory(rows, { immediate = false, load = async () => [] } = {}) {
  let current = rows;
  const listeners = new Set();
  const calls = { load: 0, unwatch: 0 };
  return {
    calls,
    options: {
      async load() { calls.load++; return load(); },
      current: () => current,
      watch(listener) {
        listeners.add(listener);
        if (immediate) listener();
        return () => { calls.unwatch++; listeners.delete(listener); };
      },
    },
    async set(rows) {
      current = rows;
      for (const listener of listeners) listener();
      await Promise.resolve();
    },
  };
}
function setup(t, rows, options) {
  const directory = fakeDirectory(rows, options);
  const tree = new MainTree(directory.options);
  t.after(() => tree.close());
  return { tree, directory };
}

test("MainTree 快照包含热节点及其祖先，冷历史由分页读取", async (t) => {
  const rows = [
    row("open"), row("running", { info: { status: "running", hosted: true } }),
    row("waiting", { info: { status: "waiting" } }), row("paused", { info: { status: "paused" } }),
    row("recent", { lastActivityAt: "2025-01-02T00:00:00.000Z", messageCount: 7 }),
    row("boundary", { lastActivityAt: recentSince }), row("cold"),
    row("other-project", { info: { cwd: path.resolve("another-project"), status: "running" } }),
  ];
  const { tree, directory } = setup(t, rows);
  const snap = await tree.snapshot(request([nodeId("open")]));
  assert.equal(directory.calls.load, 1);
  assert.equal(snap.source, "pane");
  assert.deepEqual(snap.nodes.filter((node) => node.kind === "session").map((node) => node.id).sort(),
    ["open", "running", "waiting", "paused", "recent", "other-project"].map(nodeId).sort());
  for (const node of snap.nodes.filter((node) => node.kind === "session")) {
    assert.ok(snap.nodes.some((parent) => parent.id === node.parentId && parent.kind === "group"));
  }
  const running = snap.nodes.find((node) => node.id === nodeId("running"));
  assert.equal(running.availability, "online");
  assert.ok(running.capabilities.includes("abort"));
  const recent = snap.nodes.find((node) => node.id === nodeId("recent"));
  assert.equal(recent.availability, "archived");
  assert.equal(recent.messageCount, 7);
  assert.ok(!recent.capabilities.includes("abort"));
  const page = await tree.children(recent.parentId, { epoch: snap.epoch, limit: 200 });
  assert.equal(page.nodes.length, 7);
  assert.ok(page.nodes.some((node) => node.id === nodeId("cold")));
  snap.nodes[0].title = "外部修改";
  page.nodes[0].title = "外部分页修改";
  assert.ok(!(await tree.snapshot(request())).nodes.some((node) => /外部/.test(node.title)));
});

test("MainTree 历史分页使用 keyset，游标绑定父节点及 epoch", async (t) => {
  const rows = ["a", "c", "e", "g"].map((id) => row(id));
  const { tree, directory } = setup(t, rows);
  const snap = await tree.snapshot(request());
  const parentId = snap.nodes.find((node) => node.childCount === 4).id;
  const first = await tree.children(parentId, { epoch: snap.epoch, limit: 2 });
  assert.deepEqual(first.nodes.map((node) => node.sortKey), ["a", "c"]);
  assert.equal(typeof first.nextCursor, "string");
  // 删除前页节点并在切点两侧插入节点，后页仍从原来的排序键继续。
  await directory.set(["b", "c", "d", "e", "g"].map((id) => row(id)));
  const second = await tree.children(parentId, { epoch: snap.epoch, cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.nodes.map((node) => node.sortKey), ["d", "e"]);
  const last = await tree.children(parentId, { epoch: snap.epoch, cursor: second.nextCursor, limit: 2 });
  assert.deepEqual(last.nodes.map((node) => node.sortKey), ["g"]);
  assert.equal(last.nextCursor, undefined);
  for (const invalidCursor of ["%", Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ epoch: "旧代", parentId, after: "c" })).toString("base64url")]) {
    await assert.rejects(tree.children(parentId, { epoch: snap.epoch, cursor: invalidCursor, limit: 2 }),
      { code: "invalidTreeCursor" });
  }
  await assert.rejects(tree.children("pane:group:unassigned",
    { epoch: snap.epoch, cursor: first.nextCursor, limit: 2 }), { code: "invalidTreeCursor" });
  assert.deepEqual(await tree.children(parentId, { epoch: "旧代", limit: 2 }), { reset: true, epoch: snap.epoch });
  const other = new MainTree(fakeDirectory(rows).options);
  t.after(() => other.close());
  const next = await other.snapshot(request());
  assert.notEqual(next.epoch, snap.epoch);
  assert.deepEqual(await other.children(parentId, { epoch: snap.epoch, limit: 2 }), { reset: true, epoch: next.epoch });
  const resets = [];
  other.subscribe(cursor(snap), (event) => resets.push(event));
  assert.deepEqual(resets, [{ type: "reset", epoch: next.epoch }]);
});

test("MainTree 修订号只随变化递增，删除事件与快照切点可重放", async (t) => {
  const { tree, directory } = setup(t, [row("a"), row("b")]);
  const snap = await tree.snapshot(request(["a", "b"].map(nodeId)));
  assert.equal((await tree.snapshot(request())).revision, snap.revision);
  const live = [];
  const off = tree.subscribe(cursor(snap), (event) => live.push(event));
  await directory.set([row("a", { info: { title: "新标题" }, holds: [{ source: "test", reason: "等待结果" }] })]);
  assert.ok(live.some((event) => event.type === "remove" && event.id === nodeId("b")));
  assert.equal(live.find((event) => event.node?.id === nodeId("a")).node.statusDetail, "等待结果");
  assert.deepEqual(live.map((event) => event.revision), live.map((_, index) => snap.revision + index + 1));
  const cut = await tree.snapshot(request([nodeId("a")]));
  const replay = [];
  const offReplay = tree.subscribe(cursor(snap), (event) => replay.push(event));
  assert.deepEqual(replay, live);
  const reconstructed = new Map(snap.nodes.map((node) => [node.id, node]));
  for (const change of replay) {
    if (change.type === "remove") reconstructed.delete(change.id);
    else reconstructed.set(change.node.id, change.node);
  }
  assert.deepEqual([...reconstructed.values()].sort((a, b) => a.id.localeCompare(b.id)),
    [...cut.nodes].sort((a, b) => a.id.localeCompare(b.id)));
  const atCut = [];
  const offCut = tree.subscribe(cursor(cut), (event) => atCut.push(event));
  assert.deepEqual(atCut, []);
  off();
  const liveCount = live.length;
  await directory.set([row("a", { info: { title: "切点之后" } })]);
  assert.equal(live.length, liveCount);
  assert.equal(atCut.length, 1);
  assert.equal(atCut[0].revision, cut.revision + 1);
  assert.equal(replay.at(-1).node.title, "切点之后");
  offCut(); offReplay();
});

test("MainTree 订阅日志恰好保留 2000 条，边界前一条要求 reset", async (t) => {
  const { tree, directory } = setup(t, [row("a")]);
  const start = await tree.snapshot(request());
  for (let index = 1; index <= 2000; index++) {
    await directory.set([row("a", { info: { title: `标题 ${index}` } })]);
  }
  const replay = [];
  const off = tree.subscribe(cursor(start), (event) => replay.push(event));
  assert.equal(replay.length, 2000);
  assert.equal(replay[0].revision, start.revision + 1);
  assert.equal(replay.at(-1).revision, start.revision + 2000);
  off();
  await directory.set([row("a", { info: { title: "溢出一条" } })]);
  const expired = [];
  tree.subscribe(cursor(start), (event) => expired.push(event));
  assert.deepEqual(expired, [{ type: "reset", epoch: start.epoch }]);
  const boundary = [];
  const offBoundary = tree.subscribe({ epoch: start.epoch, revision: start.revision + 1 },
    (event) => boundary.push(event));
  assert.equal(boundary.length, 2000);
  assert.equal(boundary[0].revision, start.revision + 2);
  const future = [];
  tree.subscribe({ epoch: start.epoch, revision: start.revision + 2002 }, (event) => future.push(event));
  assert.deepEqual(future, [{ type: "reset", epoch: start.epoch }]);
  offBoundary();
});

test("MainTree watch 即时通知和 refresh 均读取当前目录，忽略 load 的旧结果", async (t) => {
  let finish;
  const loading = new Promise((resolve) => { finish = resolve; });
  const { tree, directory } = setup(t, [row("current")], { immediate: true, load: () => loading });
  await Promise.resolve();
  const events = [];
  const off = tree.subscribe({ epoch: tree.epoch, revision: 0 }, (event) => events.push(event));
  assert.ok(events.some((event) => event.node?.id === nodeId("current")));
  const first = tree.refresh();
  const second = tree.refresh();
  assert.equal(first, second);
  assert.equal(directory.calls.load, 1);
  await directory.set([row("latest", { info: { status: "running" } })]);
  finish([row("stale")]);
  await first;
  const snap = await tree.snapshot(request());
  assert.deepEqual(snap.nodes.filter((node) => node.kind === "session").map((node) => node.id), [nodeId("latest")]);
  assert.equal(directory.calls.load, 2);
  off();
});

test("MainTree 隔离异常监听器和事件修改，close 取消监听且阻止迟到刷新", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const { tree, directory } = setup(t, [row("a")]);
  const snap = await tree.snapshot(request());
  const bad = tree.subscribe(cursor(snap), (event) => { event.node.title = "污染"; throw new Error("监听失败"); });
  const goodEvents = [];
  tree.subscribe(cursor(snap), (event) => goodEvents.push(event));
  await directory.set([row("a", { info: { title: "正确标题" } })]);
  assert.equal(goodEvents[0].node.title, "正确标题");
  assert.equal(error.mock.callCount(), 1);
  const replay = [];
  tree.subscribe(cursor(snap), (event) => replay.push(event));
  assert.equal(replay[0].node.title, "正确标题");
  bad();
  const count = goodEvents.length;
  tree.close(); tree.close();
  await directory.set([row("b")]);
  assert.equal(directory.calls.unwatch, 1);
  assert.equal(goodEvents.length, count);
  await assert.rejects(tree.snapshot(request()), { code: "serverStopping" });
  assert.throws(() => tree.subscribe(cursor(snap), () => {}), { code: "serverStopping" });

  let finish;
  const late = setup(t, [row("late")], { load: () => new Promise((resolve) => { finish = resolve; }) });
  const refreshing = late.tree.refresh();
  late.tree.close();
  finish([]);
  await refreshing;
  assert.equal(late.tree.revision, 0);
});

test("MainTree 拒绝无效快照、分页和订阅参数", async (t) => {
  const { tree } = setup(t, []);
  for (const invalid of [{ openNodeIds: [], recentSince: "无效日期" },
    request([1]), request(Array(1001).fill("x"))]) {
    await assert.rejects(tree.snapshot(invalid), { code: "invalidTreeRequest" });
  }
  const snap = await tree.snapshot(request());
  for (const limit of [0, -1, 201, 1.5]) {
    await assert.rejects(tree.children("pane:group:unassigned", { epoch: snap.epoch, limit }), { code: "invalidTreeRequest" });
  }
  for (const revision of [-1, 0.5, NaN]) {
    assert.throws(() => tree.subscribe({ epoch: snap.epoch, revision }, () => {}), { code: "invalidCursor" });
  }
});
