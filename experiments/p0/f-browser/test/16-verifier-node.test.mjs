// RFC 8785 向量，以及 agora #16 验签场景（签名方为 Node.js 的 WebCrypto，不可导出密钥）。
// 浏览器签名的同一组场景在 12-device-key-browser.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, b64url } from '../public/jcs.js';
import { runJcsVectors } from '../public/jcs-vectors.js';
import { runPresenceScenarios } from './presence-scenarios.mjs';
import { note } from './helpers.mjs';

test('RFC 8785 向量（Node.js）', (t) => {
  const failures = runJcsVectors(canonicalize);
  note(t, 'jcs-failures', failures);
  assert.deepEqual(failures, []);
});

function nodeSigner() {
  let keys;
  const gen = async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    keys = { pair, publicKey: b64url(spki), deviceId: b64url(await crypto.subtle.digest('SHA-256', spki)) };
    return { deviceId: keys.deviceId, publicKey: keys.publicKey };
  };
  return {
    device: gen,
    reset: gen,
    async sign(payload, { domain = 'pi-pane/user-presence/v1' } = {}) {
      const canonical = canonicalize({ domain, payload });
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.pair.privateKey, new TextEncoder().encode(canonical));
      return { deviceId: keys.deviceId, publicKey: keys.publicKey, alg: 'ECDSA-P256-SHA256', signature: b64url(sig), canonical };
    },
  };
}

test('agora #16 验签场景（Node.js 签名）', async (t) => {
  await runPresenceScenarios(nodeSigner(), (k, v) => note(t, k, v));
});
