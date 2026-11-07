import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthStore, checkOrigin } from '../packages/server/dist/auth.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const denied = (code) => (error) => error.status === 401 && error.code === code;

function clock() {
  let time = 0;
  const store = new AuthStore({ now: () => time });
  return { store, advance: (ms) => { time += ms; } };
}

const pair = (store) => store.pair(store.issuePairCode()).credential;

test('配对码包含至少 64 位随机数，只可使用一次', () => {
  const store = new AuthStore();
  const code = store.issuePairCode();
  assert.match(code, /^[a-f0-9]{20}$/);
  assert.notEqual(store.issuePairCode(), code);
  const result = store.pair(code);
  assert.equal(result.instanceId, store.instanceId);
  assert.equal(typeof result.credential, 'string');
  assert.equal(store.useCredential(result.credential), true);
  assert.throws(() => store.pair(code), denied('invalid_code'));
});

test('配对错误计入所有有效码，累计五次后全部作废，新码独立计数', () => {
  const { store } = clock();
  const first = store.issuePairCode();
  const second = store.issuePairCode();
  for (let i = 0; i < 4; i++) {
    assert.throws(() => store.pair('错误'), denied('invalid_code'));
  }
  assert.equal(store.useCredential(store.pair(first).credential), true);
  const fresh = store.issuePairCode();
  assert.throws(() => store.pair('错误'), denied('invalid_code'));
  assert.throws(() => store.pair(second), denied('invalid_code'));
  assert.equal(store.useCredential(store.pair(fresh).credential), true);
});

test('五次错误后，所有同时签发的配对码均不可用', () => {
  const { store } = clock();
  const codes = [store.issuePairCode(), store.issuePairCode()];
  for (let i = 0; i < 5; i++) assert.throws(() => store.pair('错误'), denied('invalid_code'));
  for (const code of codes) assert.throws(() => store.pair(code), denied('invalid_code'));
});

test('配对码十分钟后过期，sweep 可清理配对码', () => {
  for (const sweep of [false, true]) {
    const { store, advance } = clock();
    const code = store.issuePairCode();
    advance(10 * MINUTE + 1);
    if (sweep) store.sweep();
    assert.throws(() => store.pair(code), denied('invalid_code'));
  }
});

test('ticket 一次性，未知凭证不能签发 ticket', () => {
  const { store } = clock();
  assert.throws(() => store.issueTicket('未知凭证'), denied('unauthorized'));
  const credential = pair(store);
  const ticket = store.issueTicket(credential);
  assert.equal(store.redeemTicket(ticket), credential);
  assert.throws(() => store.redeemTicket(ticket), denied('invalid_ticket'));
  assert.throws(() => store.redeemTicket('未知票据'), denied('invalid_ticket'));
});

test('ticket 三十秒后过期，无论是否执行 sweep 都不能兑换', () => {
  for (const sweep of [false, true]) {
    const { store, advance } = clock();
    const ticket = store.issueTicket(pair(store));
    advance(30_001);
    if (sweep) store.sweep();
    assert.throws(() => store.redeemTicket(ticket), denied('invalid_ticket'));
    assert.throws(() => store.redeemTicket(ticket), denied('invalid_ticket'));
  }
});

test('HTTP 与 WS 共用凭证活动，签发和兑换 ticket 也刷新 idle', () => {
  const { store, advance } = clock();
  const credential = pair(store);
  advance(DAY - 1);
  assert.equal(store.useCredential(credential), true);
  advance(DAY - 1);
  const ticket = store.issueTicket(credential);
  advance(30_000);
  assert.equal(store.redeemTicket(ticket), credential);
  advance(DAY - 1);
  assert.equal(store.useCredential(credential), true);
  advance(DAY + 1);
  assert.equal(store.useCredential(credential), false);
  assert.throws(() => store.issueTicket(credential), denied('unauthorized'));
});

test('sweep 不刷新活动，空闲过期和显式吊销均通知一次并作废所有 ticket', () => {
  for (const mode of ['sweep', 'use', 'revoke']) {
    const { store, advance } = clock();
    const credential = pair(store);
    const tickets = [store.issueTicket(credential), store.issueTicket(credential)];
    const events = [];
    store.onRevoke((token) => events.push(token));
    advance(DAY - 1);
    store.sweep();
    assert.deepEqual(events, []);
    if (mode === 'revoke') store.revoke(credential);
    else {
      advance(2);
      if (mode === 'sweep') store.sweep();
      else assert.equal(store.useCredential(credential), false);
    }
    assert.deepEqual(events, [credential]);
    store.revoke(credential);
    store.sweep();
    assert.equal(store.useCredential(credential), false);
    assert.deepEqual(events, [credential]);
    for (const ticket of tickets) {
      assert.throws(() => store.redeemTicket(ticket), denied('invalid_ticket'));
    }
  }
});

test('吊销仅影响目标凭证，支持取消订阅和隔离失败订阅者', () => {
  const { store } = clock();
  const first = pair(store);
  const second = pair(store);
  const events = [];
  const unsubscribe = store.onRevoke(() => assert.fail('不应调用已取消的订阅者'));
  unsubscribe();
  unsubscribe();
  store.onRevoke(() => { throw new Error('订阅者错误'); });
  store.onRevoke((token) => events.push(token));
  const ticket = store.issueTicket(first);
  store.revoke(first);
  assert.deepEqual(events, [first]);
  assert.throws(() => store.redeemTicket(ticket), denied('invalid_ticket'));
  assert.equal(store.useCredential(second), true);
});

test('重启后 instanceId 改变，旧凭证、配对码和 ticket 全部失效', () => {
  const old = new AuthStore();
  const credential = pair(old);
  const code = old.issuePairCode();
  const ticket = old.issueTicket(credential);
  const restarted = new AuthStore();
  assert.notEqual(restarted.instanceId, old.instanceId);
  assert.equal(restarted.useCredential(credential), false);
  assert.throws(() => restarted.pair(code), denied('invalid_code'));
  assert.throws(() => restarted.redeemTicket(ticket), denied('invalid_ticket'));
});

test('Host 必须精确匹配，Origin 仅允许缺省或规范源，不从 Cookie 读取凭证', () => {
  const host = '127.0.0.1:4319';
  const origin = `http://${host}`;
  const hosts = [host, undefined, '', 'localhost:4319', '127.0.0.1', '127.0.0.1:4320',
    '[::1]:4319', '127.0.0.1:04319', `${host} `, `${host},evil.test`, 'evil.test:4319'];
  const origins = [undefined, origin, '', 'null', 'http://localhost:4319',
    'https://127.0.0.1:4319', 'http://127.0.0.1:4320', `${origin}/`,
    `${origin}/path`, `${origin} `, `${origin},https://evil.test`, `http://user@${host}`];
  for (const candidateHost of hosts) {
    for (const candidateOrigin of origins) {
      assert.equal(checkOrigin({ host: candidateHost, origin: candidateOrigin }, 4319),
        candidateHost === host && (candidateOrigin === undefined || candidateOrigin === origin),
        JSON.stringify({ candidateHost, candidateOrigin }));
    }
  }
  assert.equal(checkOrigin({ host: '127.0.0.1:4320', origin: 'http://127.0.0.1:4320' }, 4320), true);
  const store = new AuthStore();
  assert.equal(store.useCredential(`credential=${pair(store)}`), false);
});
