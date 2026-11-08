import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { probeSessionWriterLock, isSameProcess } from "pi-hostkit";
import { fileKey } from "../packages/server/dist/store.js";
import { piFixture, providerPath, until } from "./fixtures/helpers.mjs";
import { startServer, pair, open, control, snapshot } from "./fixtures/client.mjs";

for (const fault of ["query", "release", "cleanup-release"]) test(`取消切换后的 ${fault} 清理失败不覆盖已确认响应与幂等结果`, { timeout: 30000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: "text", text: "完成" }] } });
  const target = f.sessionPath("cancel-target");
  await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "cancel-target", cwd: f.cwd, timestamp: new Date().toISOString() }) + "\n");
  await utimes(target, new Date(0), new Date(0));
  const server = await startServer(f, { extraExtensions: [providerPath, fileURLToPath(new URL("./fixtures/session-commands.ts", import.meta.url)), fileURLToPath(new URL("./fixtures/cancel-switch.ts", import.meta.url))] });
  try {
    const token = await pair(server); const first = await control(server, token, await open(server, token, f), { type: "prompt", message: "启动" }); assert.equal(first.code, 200);
    const state = await until(async () => { const s = await snapshot(server, token, first.value.snapshot.ref.id); return s.status === "idle" && s; });
    const handle = server.sessions.records.get(state.ref.id).handle;
    const events = []; const off = server.sessions.subscribe(state.ref.id, state.cursor, e => events.push(e.event));
    let injected = false; let received;
    const raw = handle.raw.bind(handle);
    handle.raw = async (...args) => {
      const [command] = args;
      if (!injected && command.type === "get_state" && handle.locks.size > 1) {
        injected = true;
        assert.equal((await probeSessionWriterLock(target)).held, true);
        assert.equal((await probeSessionWriterLock(state.sessionFile)).held, true);
        if (fault === "query") throw new Error("injected cleanup query failure");
        const lock = handle.locks.get(fileKey(target)); const release = lock.release.bind(lock);
        lock.release = async options => {
          lock.release = release;
          assert.equal(options.writerSwitchedAway, true);
          throw new Error("injected cleanup release failure", fault === "cleanup-release" ? { cause: { coverage: "snapshot_visible", steps: [{ step: "snapshot", ok: false }], leftovers: [] } } : undefined);
        };
      }
      const response = await raw(...args);
      if (command.type === "prompt") received = structuredClone(response);
      return response;
    };
    const result = await control(server, token, state, { type: "prompt", message: "/pane-test-resume " + target }, { requestId: "confirmed-cancel" });
    assert.equal(injected, true); assert.equal(result.code, 200, JSON.stringify(result)); assert.equal(result.value.status, "accepted");
    assert.equal(received.success, true); assert.equal(received.data.disposition, "handled"); assert.deepEqual(result.value.response, received);
    assert.equal(result.value.snapshot.sessionFile, state.sessionFile);
    assert.ok(events.some(e => e.type === "pane_diagnostic" && /切换后写锁清理未确认.*injected cleanup/.test(e.message)));
    await handle.exited; assert.equal(await isSameProcess(handle.identity), "gone");
    assert.equal((await probeSessionWriterLock(target)).held, false); assert.equal((await probeSessionWriterLock(state.sessionFile)).held, false);
    const repeated = await control(server, token, state, { type: "prompt", message: "/pane-test-resume " + target }, { requestId: "confirmed-cancel" });
    assert.equal(repeated.code, 200); assert.deepEqual(repeated.value, result.value, "同 requestId 重复返回已确认的真实响应，不缓存清理错误");
    assert.equal(server.sessions.reports.at(-1).leftovers.length, 0); off();
    if (fault === "cleanup-release") {
      await handle.drain(); await server.sessions.handles.get(handle); await new Promise(setImmediate);
      assert.equal(server.sessions.handles.size, 0, "随后成功的 stop/drain 不保留失败 handle");
      let released = false; const release = server.lock.release.bind(server.lock);
      server.lock.release = async () => { released = true; await release(); };
      await assert.rejects(server.close(), AggregateError); assert.equal(released, false, "原错误携带的清理事实由实例保留");
    }
  } finally { await server.close().catch(error => { if (fault !== "cleanup-release") throw error; }); await server.lock.release(); await f.cleanup(); }
});
