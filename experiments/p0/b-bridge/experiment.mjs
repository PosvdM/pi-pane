import { createExperiment as createHarnessExperiment, RpcDriver } from '../harness/index.mjs';
export { readJsonl } from '../harness/index.mjs';

// 防护仅作用于 B 组测试进程，覆盖 start() 内部的失败清理和后续重复清理。
export function guardStop(target) {
  const stop = target.stop;
  const stopping = new WeakMap();
  target.stop = function(options) {
    if (stopping.has(this)) return stopping.get(this);
    const result = this.exitInfo || this.child.exitCode !== null || this.child.signalCode !== null
      ? this.exit
      : Promise.resolve().then(() => stop.call(this, options));
    stopping.set(this, result);
    return result;
  };
  return target;
}

guardStop(RpcDriver.prototype);
export const createExperiment = createHarnessExperiment;
