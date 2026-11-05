// pane P0 #12 与 agora P0 #16 的浏览器部分：浏览器生成不可导出的 ECDSA P-256 密钥并存入 IndexedDB，
// 签名在 Node.js 中按 RFC 8785 + ieee-p1363 验证；无痕模式；不支持的环境给出 unsupported。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startAuthServer } from '../lib/auth-server.mjs';
import { startPlainServer } from '../lib/plain-server.mjs';
import { verifyPresence, deviceIdFor } from '../lib/confirm-verifier.mjs';
import { forEachBrowser } from './browser-common.mjs';
import { runPresenceScenarios } from './presence-scenarios.mjs';
import { note } from './helpers.mjs';

function browserSigner(tab) {
  const unwrap = (r) => {
    if (r?.error) throw new Error(`browser ${r.error}: ${r.message}`);
    return r;
  };
  return {
    device: async () => unwrap(await tab.call('device')),
    reset: async () => unwrap(await tab.call('resetDevice')),
    sign: async (payload, opts = {}) => unwrap(await tab.call('signPresence', payload, opts)),
  };
}

const canMapHosts = (name) => name === 'chrome' || name === 'edge' || name === 'firefox';

test('pane #12 / agora #16 设备密钥与签名（普通窗口）', async (t) => {
  await forEachBrowser(t, async (st, open, name) => {
    const s = await startAuthServer();
    const other = await startPlainServer();
    let profileDir;
    try {
      const b = await open('normal');
      profileDir = b.profileDir;
      const A = await b.newTab();
      await A.goto(`${s.origin}/`);
      note(st, 'userAgent', await A.call('ua'));

      const support = await A.call('support');
      const jcs = await A.call('jcsVectors');
      note(st, 'support', support);
      note(st, 'jcs-vector-failures', jcs);
      assert.deepEqual(support, { ok: true });
      assert.deepEqual(jcs, []);

      const d1 = await A.call('device');
      note(st, 'device', d1);
      assert.equal(d1.created, true);
      assert.equal(deviceIdFor(d1.publicKey), d1.deviceId);
      const inspect = await A.call('inspectKey');
      note(st, 'private-key', inspect);
      assert.equal(inspect.extractable, false);
      for (const v of Object.values(inspect.exports)) assert.notEqual(v, 'EXPORTED');

      // 刷新页面后从 IndexedDB 取回同一把密钥并能签名
      await A.reload();
      const d2 = await A.call('device');
      assert.equal(d2.created, false);
      assert.equal(d2.deviceId, d1.deviceId);
      const challenge = { action: 'agora.request.answer', target: 'rq_1', paramsHash: 'x', nonce: 'n', expiresAt: '2030-01-01T00:00:00.000Z' };
      const sig = await A.call('signPresence', challenge);
      assert.equal(verifyPresence({ publicKey: sig.publicKey, signature: sig.signature, payload: challenge }), true);

      // agora #16 全部场景，签名方为浏览器
      await runPresenceScenarios(browserSigner(A), (k, v) => note(st, k, v));
      const current = await A.call('device');

      // 重启浏览器（同一配置目录）后密钥仍在
      await b.close({ keepProfile: true });
      const b2 = await open('normal', { profileDir });
      const A2 = await b2.newTab();
      await A2.goto(`${s.origin}/`);
      const d3 = await A2.call('device');
      note(st, 'after-restart', { created: d3.created, sameDevice: d3.deviceId === current.deviceId });
      assert.equal(d3.created, false);
      assert.equal(d3.deviceId, current.deviceId);

      // 另一个源（其他端口）是另一台设备
      const O = await b2.newTab();
      await O.goto(`${other.origin}/`);
      const dOther = await O.call('device');
      note(st, 'other-origin-device', { created: dOther.created, differs: dOther.deviceId !== current.deviceId });
      assert.notEqual(dOther.deviceId, current.deviceId);

      // 非安全上下文（非 loopback 主机名的 http 页面）
      if (canMapHosts(name)) {
        const I = await b2.newTab();
        await I.goto(`http://insecure.test:${other.port}/`);
        const sup = await I.call('support');
        const dev = await I.call('device');
        note(st, 'insecure-context', { support: sup, device: dev });
        assert.equal(sup.ok, false);
        assert.equal(dev.error, 'unsupported');
      } else {
        note(st, 'insecure-context', '未测：该驱动无法映射主机名');
      }
    } finally {
      await s.close();
      await other.close();
      if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

test('pane #12 设备密钥（无痕 / 隐私窗口）', async (t) => {
  await forEachBrowser(t, async (st, open, name) => {
    const s = await startAuthServer();
    try {
      const b = await open('private');
      const A = await b.newTab();
      await A.goto(`${s.origin}/`);
      const support = await A.call('support');
      const d = await A.call('device');
      const out = { support, device: d };
      if (!d.error) {
        out.inspect = await A.call('inspectKey');
        await A.reload();
        const again = await A.call('device');
        out.afterReload = { created: again.created, same: again.deviceId === d.deviceId };
        const payload = { action: 'agora.request.answer', target: 'rq_1', paramsHash: 'x', nonce: 'n', expiresAt: '2030-01-01T00:00:00.000Z' };
        const sig = await A.call('signPresence', payload);
        out.verified = verifyPresence({ publicKey: sig.publicKey, signature: sig.signature, payload });
      }
      note(st, 'private', out);
      // 通过标准：能签名并验签，或明确给出 unsupported
      if (d.error) assert.equal(d.error, 'unsupported');
      else assert.equal(out.verified, true);
      await b.close();
      // 关闭后重新打开无痕窗口：应是新设备
      if (!d.error) {
        const b2 = await open('private');
        const B = await b2.newTab();
        await B.goto(`${s.origin}/`);
        const d2 = await B.call('device');
        note(st, 'private-reopen', { created: d2.created, sameAsBefore: d2.deviceId === d.deviceId });
      }
    } finally {
      await s.close();
    }
  });
});
