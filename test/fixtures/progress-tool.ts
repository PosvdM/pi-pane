import { existsSync, watch } from "node:fs";
import path from "node:path";
import { Type } from "typebox";

// 文件门闩让浏览器先核对第一次输出，再推进下一次更新；取消时关闭监听。
function waitForFile(file: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      watcher.close(); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal?.reason ?? new Error("已取消"));
    const watcher = watch(path.dirname(file), () => { if (existsSync(file)) finish(); });
    watcher.on("error", finish);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else if (existsSync(file)) finish();
  });
}

export default function (pi) {
  pi.registerTool({
    name: "pane_test_progress", label: "受控进度", description: "按测试门闩报告两次等长输出", parameters: Type.Object({}),
    async execute(_id, _args, signal, onUpdate) {
      const gate = process.env.PANE_TOOL_GATE;
      if (!gate) throw new Error("必须设置 PANE_TOOL_GATE");
      const result = (text: string) => ({ content: [{ type: "text", text }], details: {} });
      onUpdate(result("进度 10%"));
      await waitForFile(gate + ".next", signal);
      onUpdate(result("进度 20%"));
      await waitForFile(gate + ".finish", signal);
      return result("工具已完成");
    },
  });
}
