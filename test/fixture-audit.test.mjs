import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { auditStdin } from "./fixtures/stdin-audit.mjs";

test("stdin 审计不提前开启 flowing，RPC reader 注册前的命令不会丢失", async () => {
  const stream = new PassThrough(); const records = [];
  const off = auditStdin(stream, record => records.push(record));
  assert.equal(stream.readableFlowing, null); assert.equal(stream.listenerCount("data"), 0);
  const command = Buffer.from('{"id":"init","type":"get_state"}\n'); stream.write(command);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(records, []); assert.equal(stream.readableLength, command.length);
  const received = []; stream.on("data", chunk => received.push(chunk));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(Buffer.concat(received), command); assert.equal(records[0].type, "get_state");
  off(); stream.destroy();
});

test("stdin 审计保留 UTF-8 和 JSONL 分块，同时原样转交真实 reader", async () => {
  const stream = new PassThrough(); const records = []; const received = [];
  const off = auditStdin(stream, record => records.push(record)); stream.on("data", chunk => received.push(chunk));
  const input = Buffer.from('{"type":"prompt","message":"中文"}\n{"type":"abort"}\n');
  for (const byte of input) stream.write(Buffer.from([byte]));
  assert.deepEqual(Buffer.concat(received), input); assert.deepEqual(records, [{ type: "prompt", message: "中文" }, { type: "abort" }]);
  off(); stream.destroy();
});
