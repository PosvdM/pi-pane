import { StringDecoder } from "node:string_decoder";

// 只观察真实 reader 引发的 data 事件，不添加 listener 或提前切换 flowing 状态。
export function auditStdin(stream, onRecord) {
  const emit = stream.emit; const decoder = new StringDecoder("utf8"); let pending = "";
  function observed(event, ...args) {
    if (event === "data") {
      pending += typeof args[0] === "string" ? args[0] : decoder.write(args[0]);
      const lines = pending.split("\n"); pending = lines.pop();
      for (const line of lines) { try { onRecord(JSON.parse(line)); } catch {} }
    }
    return emit.call(this, event, ...args);
  }
  stream.emit = observed;
  return () => { if (stream.emit === observed) stream.emit = emit; };
}
