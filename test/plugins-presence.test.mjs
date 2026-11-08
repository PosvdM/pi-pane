import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { PresenceBroker } from '../packages/server/dist/plugins/presence.js';
import { PaneError } from '../packages/server/dist/errors.js';

const device = (id = 'device-a') => ({
  deviceId: id, publicKey: `key-${id}`, alg: 'ECDSA-P256-SHA256', label: id, connected: true,
});
const proof = (id = 'device-a') => ({
  deviceId: id, publicKey: `key-${id}`, alg: 'ECDSA-P256-SHA256', signature: 'opaque-signature',
});
const request = (extra = {}) => ({ title: '确认操作', summary: '操作说明', payload: { amount: 1 }, ...extra });
const hasCode = code => error => error.code === code;
function setup(t) {
  const broker = new PresenceBroker();
  t.after(() => broker.close());
  const api = broker.api('plugin-a');
  const messages = new Map();
  function connect(id, credential = 'credential-a', registered = true) {
    const inbox = [];
    messages.set(id, inbox);
    broker.connect(id, credential, message => inbox.push(message));
    if (registered) broker.device(id, device(`device-${id}`));
    return inbox;
  }
  return { broker, api, connect, messages };
}

test('origin 校验在线连接和 credential，并由服务端填写设备及时间', t => {
  const { broker, connect } = setup(t);
  connect('a');
  assert.throws(() => broker.origin('a', 'credential-b'), error => error instanceof PaneError && error.status === 403);
  assert.throws(() => broker.origin('missing', 'credential-a'), hasCode('invalidOrigin'));
  const origin = broker.origin('a', 'credential-a');
  assert.equal(origin.client, 'browser');
  assert.equal(origin.connectionId, 'a');
  assert.equal(origin.deviceId, 'device-a');
  assert.ok(Number.isFinite(Date.parse(origin.receivedAt)));
  broker.disconnect('a');
  assert.throws(() => broker.origin('a', 'credential-a'), hasCode('invalidOrigin'));
});

test('有效 origin 只发给发起标签页，其他在线连接不能拒绝或确认', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  const b = connect('b');
  const pending = api.confirm(request({ origin: broker.origin('a', 'credential-a') }));
  const id = a[0].request.id;
  assert.equal(b.length, 0);
  broker.respond('b', id, { error: 'rejected' });
  broker.respond('b', id, { proof: proof('device-b') });
  broker.respond('a', id, { proof: proof('device-a') });
  assert.deepEqual(await pending, proof('device-a'));
});

test('无 origin、伪造 origin、离线 origin 和重连前 origin 均回退到全部登录连接', async t => {
  const { broker, api, connect } = setup(t);
  connect('a');
  const oldOrigin = broker.origin('a', 'credential-a');
  broker.disconnect('a');
  const b = connect('b');
  const offline = api.confirm(request({ origin: oldOrigin }));
  broker.respond('b', b.at(-1).request.id, { error: 'rejected' });
  await assert.rejects(offline, hasCode('rejected'));
  const a = connect('a');
  for (const origin of [undefined, { ...oldOrigin }, oldOrigin]) {
    const pending = api.confirm(request({ origin }));
    const id = a.at(-1).request.id;
    assert.equal(b.at(-1).request.id, id);
    assert.deepEqual(a.at(-1), { type: 'presence', request: { id, ...request(), source: 'plugin-a' } });
    broker.respond('b', id, { proof: proof('device-b') });
    assert.deepEqual(await pending, proof('device-b'));
    assert.deepEqual(a.at(-1), { type: 'presenceClosed', id, reason: 'confirmed' });
  }
});

test('同一批并发确认相互独立，首个有效响应获胜并关闭其他标签页', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  const b = connect('b');
  const first = api.confirm(request());
  const second = api.confirm(request());
  const [one, two] = a.map(message => message.request.id);
  assert.notEqual(one, two);
  broker.respond('a', one, { proof: proof('device-a') });
  broker.respond('b', one, { error: 'rejected' });
  broker.respond('b', two, { error: 'rejected' });
  broker.respond('a', two, { proof: proof('device-a') });
  assert.deepEqual(await first, proof('device-a'));
  await assert.rejects(second, hasCode('rejected'));
  assert.deepEqual(b.at(-1), { type: 'presenceClosed', id: one, reason: 'confirmed' });
  assert.deepEqual(a.at(-1), { type: 'presenceClosed', id: two, reason: 'cancelled' });
});

test('proof 结构、算法和设备必须匹配连接，签名内容保持不透明', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  const pending = api.confirm(request());
  const id = a[0].request.id;
  for (const response of [
    null, {}, { proof: {} }, { proof: proof('device-b') },
    { proof: { ...proof('device-a'), alg: 'RSA' } },
    { proof: { ...proof('device-a'), signature: 1 } },
    { proof: { ...proof('device-a'), signature: '' } },
    { proof: { ...proof('device-a'), publicKey: 'other-key' } },
    { proof: proof('device-a'), error: 'rejected' }, { error: 'arbitrary' },
  ]) broker.respond('a', id, response);
  const valid = proof('device-a');
  broker.respond('a', id, { proof: valid });
  valid.signature = 'mutated';
  assert.equal((await pending).signature, 'opaque-signature');
});

test('未注册设备的登录浏览器也会收到挑战，可返回 unsupported', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a', 'credential-a', false);
  assert.deepEqual(api.devices(), []);
  const pending = api.confirm(request());
  broker.respond('a', a[0].request.id, { proof: proof() });
  broker.respond('a', a[0].request.id, { error: 'unsupported' });
  await assert.rejects(pending, hasCode('unsupported'));
});

test('没有在线浏览器立即 noDevice', async t => {
  const { api } = setup(t);
  await assert.rejects(api.confirm(request()), hasCode('noDevice'));
});

test('断连移除挑战接收者，最后一个接收者断连后立即清理', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  const b = connect('b');
  const pending = api.confirm(request());
  const id = a[0].request.id;
  broker.disconnect('a');
  broker.respond('a', id, { error: 'rejected' });
  broker.respond('b', id, { proof: proof('device-b') });
  await pending;
  const directed = api.confirm(request({ origin: broker.origin('b', 'credential-a') }));
  broker.disconnect('b');
  await assert.rejects(directed, hasCode('noDevice'));
  assert.equal(b.filter(message => message.type === 'presence').length, 2);
});

test('同名连接重连不能继承旧挑战', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  connect('b');
  const pending = api.confirm(request());
  const id = a[0].request.id;
  connect('a');
  broker.respond('a', id, { error: 'rejected' });
  broker.respond('b', id, { proof: proof('device-b') });
  assert.deepEqual(await pending, proof('device-b'));
});

test('设备去重、注册校验、快照和监听异常隔离', t => {
  const { broker, api, connect } = setup(t);
  let calls = 0;
  api.onDevicesChange(() => { throw new Error('listener failure'); });
  const dispose = api.onDevicesChange(() => { calls++; });
  connect('a');
  connect('b');
  broker.device('b', device('device-a'));
  assert.equal(calls, 3);
  assert.equal(api.devices().length, 1);
  const devices = api.devices();
  devices[0].label = 'mutated';
  assert.equal(api.devices()[0].label, 'device-a');
  const registration = { ...device('device-a'), connected: false };
  broker.device('a', registration);
  registration.publicKey = 'mutated';
  assert.equal(api.devices()[0].publicKey, 'key-device-a');
  assert.equal(api.devices()[0].connected, true);
  for (const invalid of [null, {}, { ...device(), alg: 'RSA' }, { ...device(), label: 1 }, { ...device(), connected: 1 }, { ...device(), deviceId: '' }, { ...device(), publicKey: '' }]) {
    assert.throws(() => broker.device('a', invalid), hasCode('invalidPresenceDevice'));
  }
  assert.throws(() => broker.device('missing', device()), hasCode('invalidOrigin'));
  dispose();
  dispose();
  broker.disconnect('a');
  broker.disconnect('b');
  assert.equal(calls, 4);
  assert.deepEqual(api.devices(), []);
});

test('cancelSource 只取消对应插件的确认和监听，close 清理全部请求', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  const other = broker.api('plugin-b');
  let aCalls = 0;
  let bCalls = 0;
  api.onDevicesChange(() => aCalls++);
  other.onDevicesChange(() => bCalls++);
  const one = api.confirm(request());
  const two = other.confirm(request());
  broker.cancelSource('plugin-a');
  await assert.rejects(one, hasCode('rejected'));
  assert.deepEqual(a.at(-1), { type: 'presenceClosed', id: a[0].request.id, reason: 'cancelled' });
  broker.device('a', device('device-a'));
  assert.equal(aCalls, 0);
  assert.equal(bCalls, 1);
  broker.close();
  await assert.rejects(two, hasCode('rejected'));
  assert.deepEqual(a.at(-1), { type: 'presenceClosed', id: a[1].request.id, reason: 'cancelled' });
  assert.equal(bCalls, 1);
  assert.deepEqual(api.devices(), []);
  await assert.rejects(api.confirm(request()), hasCode('noDevice'));
  assert.throws(() => connect('c'), hasCode('presenceClosed'));
  broker.cancelSource('plugin-a');
  broker.close();
});

test('超时默认两分钟、最长十分钟，并关闭所有收到挑战的标签页', async t => {
  const { broker, api, connect } = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = connect('a');
  const b = connect('b');
  for (const [timeoutMs, duration] of [[undefined, 120_000], [900_000, 600_000], [25, 25]]) {
    const pending = api.confirm(request({ timeoutMs }));
    const id = a.at(-1).request.id;
    const rejection = assert.rejects(pending, hasCode('timeout'));
    t.mock.timers.tick(duration - 1);
    assert.equal(a.at(-1).type, 'presence');
    t.mock.timers.tick(1);
    await rejection;
    assert.deepEqual(a.at(-1), { type: 'presenceClosed', id, reason: 'timeout' });
    assert.deepEqual(b.at(-1), { type: 'presenceClosed', id, reason: 'timeout' });
    broker.respond('a', id, { proof: proof('device-a') });
  }
});

test('严格 JSON 校验拒绝丢失信息的 payload 和无效超时', async t => {
  const { api, connect } = setup(t);
  connect('a');
  const cycle = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter must not execute'); } });
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const extraArray = Object.assign([1], { extra: 2 });
  for (const payload of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol('x'), cycle,
    { x: undefined }, [undefined], [NaN], new Array(1), extraArray, new Date(), new Map(), accessor, hidden,
    { [Symbol('x')]: 1 }, { toJSON() { return 1; } },
  ]) await assert.rejects(api.confirm(request({ payload })), hasCode('invalidPresencePayload'));
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, '10']) {
    await assert.rejects(api.confirm(request({ timeoutMs })), hasCode('invalidPresenceRequest'));
  }
  await assert.rejects(api.confirm(request({ title: 1 })), hasCode('invalidPresenceRequest'));
});

test('payload 快照隔离原引用和不同接收者，共享引用与特殊对象键可表达', async t => {
  const { broker, api } = setup(t);
  const received = [];
  broker.connect('a', 'credential-a', message => {
    received.push(structuredClone(message));
    if (message.type === 'presence') message.request.payload.nested.value = 99;
  });
  broker.device('a', device('device-a'));
  const b = [];
  broker.connect('b', 'credential-a', message => b.push(message));
  const shared = { value: 1 };
  const payload = { nested: shared, shared, array: [null, true, 3], ...JSON.parse('{"__proto__":{"safe":true}}') };
  const pending = api.confirm(request({ payload }));
  payload.nested.value = 7;
  payload.array.push('changed');
  assert.equal(b[0].request.payload.nested.value, 1);
  assert.equal(b[0].request.payload.shared.value, 1);
  assert.deepEqual(b[0].request.payload.array, [null, true, 3]);
  assert.deepEqual(b[0].request.payload.__proto__, { safe: true });
  assert.equal(Object.getPrototypeOf(b[0].request.payload), Object.prototype);
  broker.respond('a', received[0].request.id, { proof: proof('device-a') });
  await pending;
});

test('发送异常不影响其他连接，全部发送失败时立即 noDevice', async t => {
  const { broker, api, connect } = setup(t);
  broker.connect('broken', 'credential-a', () => { throw new Error('send failure'); });
  const a = connect('a');
  const pending = api.confirm(request());
  broker.respond('a', a[0].request.id, { proof: proof('device-a') });
  await pending;
  broker.disconnect('a');
  await assert.rejects(api.confirm(request()), hasCode('noDevice'));
});

test('同步发送回调不能让尚未收到挑战的连接响应，也不能阻断断连后的广播', async t => {
  const { broker, api } = setup(t);
  const b = [];
  broker.connect('a', 'credential-a', message => {
    if (message.type !== 'presence') return;
    broker.respond('b', message.request.id, { error: 'rejected' });
    broker.disconnect('a');
  });
  broker.connect('b', 'credential-a', message => b.push(message));
  broker.device('b', device('device-b'));
  const pending = api.confirm(request());
  assert.equal(b[0].type, 'presence');
  broker.respond('b', b[0].request.id, { proof: proof('device-b') });
  await pending;
});

test('失败的关闭通知不影响其他连接', async t => {
  const { broker, api, connect } = setup(t);
  broker.connect('a', 'credential-a', message => {
    if (message.type === 'presenceClosed') throw new Error('closed send failure');
  });
  const b = connect('b');
  const c = connect('c');
  const pending = api.confirm(request());
  const id = b[0].request.id;
  broker.respond('b', id, { error: 'rejected' });
  await assert.rejects(pending, hasCode('rejected'));
  assert.deepEqual(c.at(-1), { type: 'presenceClosed', id, reason: 'cancelled' });
});

test('unsupported 向其他接收者发送 cancelled，来源取消和关闭通知全部接收者', async t => {
  const { broker, api, connect } = setup(t);
  const a = connect('a');
  const b = connect('b');
  const unsupported = api.confirm(request());
  const firstId = a[0].request.id;
  broker.respond('a', firstId, { error: 'unsupported' });
  await assert.rejects(unsupported, hasCode('unsupported'));
  assert.equal(a.length, 1);
  assert.deepEqual(b.at(-1), { type: 'presenceClosed', id: firstId, reason: 'cancelled' });
  for (const stop of [() => broker.cancelSource('plugin-a'), () => broker.close()]) {
    const pending = api.confirm(request());
    const id = a.at(-1).request.id;
    stop();
    await assert.rejects(pending, hasCode('rejected'));
    for (const inbox of [a, b]) {
      assert.deepEqual(inbox.at(-1), { type: 'presenceClosed', id, reason: 'cancelled' });
    }
  }
});

test('同步确认获胜后不向尚未发送的连接发送挑战或关闭帧', async t => {
  const { broker, api } = setup(t);
  const a = [];
  const b = [];
  broker.connect('a', 'credential-a', message => {
    a.push(message);
    if (message.type === 'presence') broker.respond('a', message.request.id, { proof: proof('device-a') });
  });
  broker.device('a', device('device-a'));
  broker.connect('b', 'credential-a', message => b.push(message));
  assert.deepEqual(await api.confirm(request()), proof('device-a'));
  assert.equal(a.length, 1);
  assert.deepEqual(b, []);
});

test('确认定时器 unref，不阻止进程退出', () => {
  const moduleUrl = new URL('../packages/server/dist/plugins/presence.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { PresenceBroker } from ${JSON.stringify(moduleUrl)};
    const broker = new PresenceBroker();
    broker.connect('a', 'credential-a', () => {});
    broker.api('plugin-a').confirm({ title: '确认', summary: '', payload: null });
  `], { timeout: 5000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
