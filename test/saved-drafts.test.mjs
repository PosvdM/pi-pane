// 待取回条的浏览器逻辑（packages/web/src/lib/saved-drafts.ts）：领取的重试与期限、列表乱序、按记录的忙碌状态，
// 以及放回、放弃按发起时的会话处理。用替身 fetch 模拟服务端，不启动浏览器。
import test from "node:test";
import assert from "node:assert/strict";
import { CLAIM_RETRY_MS, claimKey, claimSaved, claiming, refreshSaved, savedDrafts, takeSaved } from "../packages/web/src/lib/saved-drafts.ts";

const record = (id, value = id) => ({ id, reason: "shutdown", at: "2026-11-25T00:00:00.000Z", drafts: [{ nodes: [{ type: "text", text: value }], uncertain: false }] });
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
/** 替身 fetch：handler 按请求返回 Response 或抛错；calls 记录路径和请求体。测试结束后恢复原 fetch。 */
function fakeFetch(t, handler) {
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    const call = { path: String(path), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
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
  const claimed = await claimSaved("S", "r", clock.sleep);
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

test("领取：网络中断超过期限时抛出网络错误；服务端返回 pending 时每秒轮询，超过期限抛出 claimTimeout", async (t) => {
  const clock = fakeClock(t);
  let calls = fakeFetch(t, (call) => { if (call.method === "GET") return json({ records: [] }); throw new TypeError("Failed to fetch"); });
  const start = clock.now;
  await assert.rejects(claimSaved("S", "r", clock.sleep), (error) => error.code === "network");
  assert.ok(clock.now - start > CLAIM_RETRY_MS && clock.now - start <= CLAIM_RETRY_MS + 5000, "重试到期限为止");
  assert.ok(Math.max(...clock.slept) <= 5000);

  clock.slept.length = 0;
  calls = fakeFetch(t, (call) => call.method === "GET" ? json({ records: [] }) : json({ status: "pending" }));
  await assert.rejects(claimSaved("S", "r", clock.sleep), (error) => error.code === "claimTimeout");
  assert.ok(clock.slept.every((ms) => ms === 1000), "pending 时每秒轮询");
  assert.ok(clock.slept.length >= CLAIM_RETRY_MS / 1000 && clock.slept.length <= CLAIM_RETRY_MS / 1000 + 1, "轮询不超过期限");
  assert.equal(new Set(claims(calls).map((call) => call.body.requestId)).size, 1);
  assert.equal(claiming.get().size, 0, "失败后同样解除忙碌状态");

  // 其他错误（如 403）不重试，直接抛出。
  calls = fakeFetch(t, (call) => call.method === "GET" ? json({ records: [] }) : new Response(JSON.stringify({ error: "forbidden", message: "拒绝" }), { status: 403 }));
  await assert.rejects(claimSaved("S", "r", clock.sleep), (error) => error.status === 403);
  assert.equal(claims(calls).length, 1);
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
