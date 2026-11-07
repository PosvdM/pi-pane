import test from "node:test";
import assert from "node:assert/strict";
import { checkStopReport } from "../packages/server/dist/driver.js";
const step = (name, ok) => ({ step: name, ok, at: new Date().toISOString() });
test("快照信号失败在最终复查确认退出后可接受，不能把中间 EPERM 当作残留", () => {
 const report = { coverage: "snapshot_visible", leftovers: [], steps: [step("snapshot cleanup", false), step("verify", true)] };
 assert.doesNotThrow(() => checkStopReport(report));
 assert.throws(() => checkStopReport({ ...report, steps: [step("snapshot cleanup", false)] }), { code: "stopIncomplete" });
 assert.throws(() => checkStopReport({ ...report, steps: [step("snapshot cleanup", false), step("verify", false)] }), { code: "stopIncomplete" });
 assert.throws(() => checkStopReport({ ...report, leftovers: [{ pid: 123, startTime: "recorded" }] }), { code: "stopIncomplete" });
 assert.throws(() => checkStopReport({ ...report, steps: [step("snapshot", false), step("verify", true)] }), { code: "stopIncomplete" });
 assert.throws(() => checkStopReport({ ...report, coverage: "unknown" }), { code: "stopCoverage" });
});
