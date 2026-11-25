// 待取回条的浏览器逻辑（packages/web/src/lib/saved-drafts.ts）：领取的重试与期限、列表乱序、按记录的忙碌状态，
// 以及放回、放弃按发起时的会话处理。用替身 fetch 模拟服务端，不启动浏览器。
import test from "node:test";
import assert from "node:assert/strict";
import { CLAIM_RETRY_MS, awaiting, claimKey, claimSaved, claimsKey, claiming, pendingClaims, refreshSaved, restoreClaims, savedDrafts, savedItems, takeSaved } from "../packages/web/src/lib/saved-drafts.ts";

const record = (id, value = id) => ({ id, reason: "shutdown", at: "2026-11-25T00:00:00.000Z", drafts: [{ nodes: [{ type: "text", text: value }], uncertain: false }] });
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

const text = (value) => [{ type: "text", text: value }];
class MemoryStorage {
  items = new Map();
  get length() { return this.items.size; }
  key(i) { return [...this.items.keys()][i] ?? null; }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) { this.items.set(key, String(value)); }
  removeItem(key) { this.items.delete(key); }
}

const realFetch = globalThis.fetch;
/** 替身 fetch：handler 按请求返回 Response 或抛错；calls 记录路径和请求体。测试结束后恢复原 fetch。 */
function fakeFetch(t, handler) {
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    const call = { path: String(path), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    calls.push(call);
    return handler(call, calls);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}
/** 可控的时钟：sleep 只推进时间，不真的等待。 */
function fakeClock(t) {
  const original = Date.now; const clock = { now: original(), slept: [] };
  Date.now = () => clock.now;
  clock.sleep = async (ms) => { clock.slept.push(ms); clock.now += ms; };
  t.after(() => { Date.now = original; });
  return clock;
}
const claims = (calls) => calls.filter((call) => call.method === "POST");
const lists = (calls) => calls.filter((call) => call.method === "GET");

test("领取：网络中断时用同一 requestId 重试，退避到 5 秒为止；拿到结果后从本页列表去掉并重新读取", async (t) => {
  const clock = fakeClock(t); let failures = 4;
  const calls = fakeFetch(t, (call) => {
    if (call.method === "GET") return json({ records: [] });
    if (failures-- > 0) throw new TypeError("Failed to fetch");
    return json({ status: "claimed", record: record("r", "甲") });
  });
  savedDrafts.set(new Map([["S", [record("r"), record("q")]]]));
  const claimed = await claimSaved("S", "r", { sleep: clock.sleep });
  assert.deepEqual(claimed, record("r", "甲"));
  const posts = claims(calls);
  assert.equal(posts.length, 5);
  assert.equal(new Set(posts.map((call) => call.body.requestId)).size, 1, "重试复用同一 requestId");
  assert.ok(posts.every((call) => call.path === "/api/sessions/S/drafts/r/claim"));
  assert.deepEqual(clock.slept, [500, 1000, 2000, 4000]);
  assert.deepEqual(savedDrafts.get().get("S").map((item) => item.id), ["q"], "立即从本页列表去掉，不等重新读取");
  assert.equal(lists(calls).length, 1, "结束后重新读取列表");
  assert.equal(claiming.get().size, 0);
});

test("领取：网络中断超过期限时抛出 claimTimeout，期限外不再发请求；服务端返回 pending 时每秒轮询，同样不超过期限", async (t) => {
  const clock = fakeClock(t);
  const start = clock.now; const sent = [];
  let calls = fakeFetch(t, (call) => { if (call.method === "GET") return json({ records: [] }); sent.push(clock.now); throw new TypeError("Failed to fetch"); });
  await assert.rejects(claimSaved("S", "r", { sleep: clock.sleep }), (error) => error.code === "claimTimeout");
  assert.equal(clock.now - start, CLAIM_RETRY_MS, "最后一次退避截在期限处");
  assert.ok(sent.every((at) => at < start + CLAIM_RETRY_MS), "期限外不再发出请求");
  assert.ok(Math.max(...clock.slept) <= 5000);

  clock.slept.length = 0;
  calls = fakeFetch(t, (call) => call.method === "GET" ? json({ records: [] }) : json({ status: "pending" }));
  await assert.rejects(claimSaved("S", "r", { sleep: clock.sleep }), (error) => error.code === "claimTimeout");
  assert.ok(clock.slept.every((ms) => ms === 1000), "pending 时每秒轮询");
  assert.equal(clock.slept.length, CLAIM_RETRY_MS / 1000, "轮询不超过期限");
  assert.equal(new Set(claims(calls).map((call) => call.body.requestId)).size, 1);
  assert.equal(claiming.get().size, 0, "失败后同样解除忙碌状态");

  // 其他错误（如 403）不重试，直接抛出。
  calls = fakeFetch(t, (call) => call.method === "GET" ? json({ records: [] }) : new Response(JSON.stringify({ error: "forbidden", message: "拒绝" }), { status: 403 }));
  await assert.rejects(claimSaved("S", "r", { sleep: clock.sleep }), (error) => error.status === 403);
  assert.equal(claims(calls).length, 1);
});

test("领取：确定的错误响应丢掉原 requestId，下次领取换新的；结果未知（网络中断）才沿用", async (t) => {
  const bodies = []; let respond;
  fakeFetch(t, (call) => {
    if (call.method === "GET") return json({ records: [] });
    bodies.push(call.body.requestId);
    return respond();
  });
  pendingClaims.set(new Map());
  // 服务端执行领取时出错：该 requestId 的结果已缓存为这个错误。
  respond = () => new Response(JSON.stringify({ error: "internalError", message: "读取失败" }), { status: 500 });
  await assert.rejects(claimSaved("E", "r"), (error) => error.status === 500);
  assert.equal(pendingClaims.get().size, 0, "确定的错误不留结果未知的领取");
  respond = () => json({ status: "claimed", record: record("r") });
  await claimSaved("E", "r");
  assert.notEqual(bodies[1], bodies[0], "确定的错误之后换新的 requestId");
  // 期限内一直网络中断：结果未知，保留，之后沿用。
  respond = () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(claimSaved("E", "q", { limit: 30, sleep: async () => {} }), (error) => error.code === "claimTimeout");
  assert.equal(pendingClaims.get().get(claimKey("E", "q")).requestId, bodies.at(-1));
  respond = () => json({ status: "gone" });
  assert.equal(await claimSaved("E", "q"), null);
  assert.equal(bodies.at(-1), bodies.at(-2), "结果未知之后沿用原 requestId");
  assert.equal(pendingClaims.get().size, 0, "得到 gone 后删除");
});

test("领取响应丢失：列表推送已删除该条后，结果未知的领取仍显示在待取回条中，点“重试”沿用原 requestId 拿到草稿；放弃的重试不再确认", async (t) => {
  let server = []; const bodies = []; let hang = true;
  fakeFetch(t, (call) => {
    if (call.method === "GET") return json({ records: server });
    bodies.push(call.body.requestId);
    // 服务端已领取并删除记录，响应没有交到页面。
    server = server.filter((item) => !call.path.includes(`/drafts/${item.id}/`));
    if (hang) return new Promise((resolve, reject) => call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    return json({ status: "claimed", record: record("r", "领回的草稿") });
  });
  pendingClaims.set(new Map()); savedDrafts.set(new Map());
  server = [record("r", "领回的草稿"), record("d", "要放弃的")];
  await refreshSaved("L");
  const deps = ui("ok");
  const shown = () => savedItems(savedDrafts.get(), awaiting.get(), pendingClaims.get(), "L");
  // 用很短的期限代替 120 秒：takeSaved 用默认期限，这里直接调用 claimSaved。
  await assert.rejects(claimSaved("L", "r", { limit: 50 }, { record: record("r", "领回的草稿") }), (error) => error.code === "claimTimeout");
  await refreshSaved("L");
  assert.deepEqual(savedDrafts.get().get("L").map((item) => item.id), ["d"], "服务端列表已没有这一条");
  assert.deepEqual(shown().map((item) => [item.record.id, item.pending !== null]), [["d", false], ["r", true]], "结果未知的领取仍在条中");
  hang = false;
  assert.equal(await takeSaved("L", shown()[1].record, false, deps), "restored");
  assert.equal(bodies[1], bodies[0], "重试沿用原 requestId");
  assert.deepEqual(deps.delivered, [{ sessionId: "L", drafts: [{ nodes: text("领回的草稿"), uncertain: false }] }]);
  assert.deepEqual(shown().map((item) => item.record.id), ["d"], "得到确定结果后从条中去掉");

  // 放弃的结果未知：重试仍是放弃，不再确认，也不放回输入框。
  hang = true;
  await assert.rejects(claimSaved("L", "d", { limit: 50 }, { record: record("d"), discard: true }), (error) => error.code === "claimTimeout");
  hang = false;
  const asked = ui(() => { throw new Error("不应再确认"); });
  assert.equal(await takeSaved("L", shown().find((item) => item.record.id === "d").record, false, asked), "discarded");
  assert.deepEqual(asked.delivered, []);
  assert.equal(pendingClaims.get().size, 0);
});

test("结果未知的领取按 tabId 存在 sessionStorage 中：刷新后恢复并能重试；复制标签页带来的其他 tabId 的项删除", async (t) => {
  const session = new MemoryStorage(); const bodies = [];
  let respond = () => { throw new TypeError("Failed to fetch"); };
  fakeFetch(t, (call) => { if (call.method === "GET") return json({ records: [] }); bodies.push(call.body.requestId); return respond(); });
  pendingClaims.set(new Map());
  restoreClaims(session, "tab-a");
  session.setItem(claimsKey("tab-old"), "[]");
  await assert.rejects(claimSaved("F", "r", { limit: 30, sleep: async () => {} }, { record: record("r", "刷新前") }), (error) => error.code === "claimTimeout");
  const saved = JSON.parse(session.getItem(claimsKey("tab-a")));
  assert.equal(saved.length, 1); assert.equal(saved[0].requestId, bodies[0]);
  // 刷新：内存中的状态没有了，从 sessionStorage 恢复。
  pendingClaims.set(new Map());
  restoreClaims(session, "tab-a");
  assert.equal(session.getItem(claimsKey("tab-old")), null, "其他 tabId 的项属于原标签页，删除");
  const items = savedItems(new Map(), new Set(), pendingClaims.get(), "F");
  assert.deepEqual(items.map((item) => [item.record.id, item.pending?.requestId]), [["r", bodies[0]]]);
  respond = () => json({ status: "claimed", record: record("r", "刷新前") });
  const deps = ui("ok");
  assert.equal(await takeSaved("F", items[0].record, false, deps), "restored");
  assert.equal(bodies.at(-1), bodies[0], "刷新后重试沿用原 requestId");
  assert.equal(session.getItem(claimsKey("tab-a")), null, "得到确定结果后删除");
  restoreClaims(null, "x");
});

test("领取：挂住的请求在总期限到时中止并抛出 claimTimeout；再次领取同一记录沿用原 requestId，领到或 gone 之后才换新的", async (t) => {
  const bodies = []; let hang = true;
  fakeFetch(t, (call) => {
    if (call.method === "GET") return json({ records: [] });
    bodies.push(call.body.requestId);
    if (!hang) return json({ status: "claimed", record: record("r", "迟到的领取") });
    // 服务端没有响应：只能由期限中止。
    return new Promise((resolve, reject) => call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  });
  const started = Date.now();
  await assert.rejects(claimSaved("H", "r", { limit: 80 }), (error) => error.code === "claimTimeout");
  assert.ok(Date.now() - started < 1000, "挂住的请求按总期限结束");
  assert.equal(claiming.get().size, 0);
  // 客户端放弃后服务端才完成领取：再次领取用原 requestId，取回同一份结果。
  hang = false;
  assert.deepEqual(await claimSaved("H", "r"), record("r", "迟到的领取"));
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1], "沿用原 requestId");
  await claimSaved("H", "r");
  assert.notEqual(bodies[2], bodies[0], "领到之后的新领取换新的 requestId");
  await claimSaved("H", "q");
  assert.equal(new Set(bodies.slice(2)).size, 2, "不同记录用不同的 requestId");
});

test("领取期间只有该记录处于忙碌状态，同一会话的其他记录和其他会话不受影响", async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  fakeFetch(t, async (call) => {
    if (call.method === "GET") return json({ records: [] });
    if (call.path === "/api/sessions/S/drafts/r/claim") await gate;
    return json({ status: "gone" });
  });
  const stuck = claimSaved("S", "r");
  assert.deepEqual([...claiming.get()], [claimKey("S", "r")]);
  assert.equal(await claimSaved("S", "q"), null, "同一会话的另一条可以领取");
  assert.equal(await claimSaved("T", "r"), null, "其他会话同名记录可以领取");
  assert.deepEqual([...claiming.get()], [claimKey("S", "r")]);
  release();
  assert.equal(await stuck, null);
  assert.equal(claiming.get().size, 0);
  assert.notEqual(claimKey("a", "b.c"), claimKey("a.b", "c"), "键不会因分隔符混淆");
});

test("读取列表：只采用最后一次发起的读取，乱序到达的旧列表丢弃；读取失败时保留已显示的列表", async (t) => {
  const pending = [];
  fakeFetch(t, () => new Promise((resolve) => pending.push(resolve)));
  savedDrafts.set(new Map());
  const first = refreshSaved("S"); const second = refreshSaved("S");
  await new Promise((resolve) => setImmediate(resolve));
  pending[1](json({ records: [record("新")] })); await second;
  pending[0](json({ records: [record("旧")] })); await first;
  assert.deepEqual(savedDrafts.get().get("S").map((item) => item.id), ["新"]);

  fakeFetch(t, () => { throw new TypeError("Failed to fetch"); });
  await refreshSaved("S");
  assert.deepEqual(savedDrafts.get().get("S").map((item) => item.id), ["新"], "读取失败时保留");
});

/** takeSaved 的界面替身：nav 为导航代次，toasts、delivered 记录提示和放回。 */
function ui(answer) {
  const deps = { nav: 1, toasts: [], delivered: [] };
  deps.navigation = () => deps.nav;
  deps.ask = async () => typeof answer === "function" ? answer(deps) : answer;
  deps.toast = (message) => deps.toasts.push(message);
  deps.deliver = (sessionId, drafts) => deps.delivered.push({ sessionId, drafts });
  return deps;
}

test("放弃：确认期间切换了会话时不执行；取消时不执行；确认后领取并丢弃内容", async (t) => {
  const calls = fakeFetch(t, (call) => call.method === "GET" ? json({ records: [] }) : json({ status: "claimed", record: record("r") }));
  let deps = ui((d) => { d.nav++; return "ok"; });
  assert.equal(await takeSaved("S", record("r"), true, deps), "navigated");
  assert.equal(claims(calls).length, 0, "确认期间切换会话后不对原会话执行放弃");
  deps = ui("cancel");
  assert.equal(await takeSaved("S", record("r"), true, deps), "cancelled");
  assert.equal(claims(calls).length, 0);
  deps = ui("ok");
  assert.equal(await takeSaved("S", record("r"), true, deps), "discarded");
  assert.equal(claims(calls).length, 1); assert.deepEqual(deps.delivered, []); assert.deepEqual(deps.toasts, ["已放弃"]);
});

test("放回或放弃的结果迟到、已切换到其他会话时：放回的草稿仍交给原会话，提示不在其他会话中显示", async (t) => {
  let respond; const outcome = (value) => respond(json(value));
  fakeFetch(t, (call) => call.method === "GET" ? json({ records: [] }) : new Promise((resolve) => { respond = resolve; }));
  for (const [discard, value, result] of [[false, { status: "claimed", record: record("r", "迟到") }, "restored"], [false, { status: "gone" }, "gone"], [true, { status: "claimed", record: record("r") }, "discarded"]]) {
    const deps = ui("ok");
    const taking = takeSaved("S", record("r"), discard, deps);
    await new Promise((resolve) => setImmediate(resolve));
    deps.nav++;
    outcome(value);
    assert.equal(await taking, result);
    assert.deepEqual(deps.toasts, [], `${result}：迟到的结果不在其他会话中提示`);
    assert.deepEqual(deps.delivered, result === "restored" ? [{ sessionId: "S", drafts: [{ nodes: [{ type: "text", text: "迟到" }], uncertain: false }] }] : []);
  }
  // 仍在原会话时照常提示。
  const deps = ui("ok");
  const taking = takeSaved("S", record("r"), false, deps);
  await new Promise((resolve) => setImmediate(resolve));
  outcome({ status: "gone" });
  assert.equal(await taking, "gone");
  assert.deepEqual(deps.toasts, ["这些消息已在其他页面放回或放弃"]);
});
