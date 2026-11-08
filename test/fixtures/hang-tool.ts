import { spawn } from "node:child_process";
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "pane_test_shell", label: "阻塞 shell", description: "在隔离测试中启动受控进程树并忽略取消", parameters: Type.Object({ command: Type.String() }),
    async execute(_id, { command }) { spawn(command, { shell: true, stdio: "ignore", env: process.env }); await new Promise(() => {}); }
  });
}
