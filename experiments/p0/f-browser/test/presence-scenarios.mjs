// agora #16 的验签场景，Node 签名器和浏览器签名器共用。
// signer：{ device() -> {deviceId, publicKey}, sign(payload, {domain}) -> proof+canonical, reset() -> 新设备 }
import assert from 'node:assert/strict';
import { ConfirmationService, verifyPresence, deviceIdFor, paramsHash } from '../lib/confirm-verifier.mjs';
import { canonicalize, PRESENCE_DOMAIN } from '../public/jcs.js';
import { trickyPayload } from '../public/jcs-vectors.js';

const proofOf = (s) => ({ deviceId: s.deviceId, publicKey: s.publicKey, alg: s.alg, signature: s.signature });

export async function runPresenceScenarios(signer, note) {
  let clock = Date.now();
  const svc = new ConfirmationService({ now: () => clock, canExecute: (p) => p.target !== 'rq_closed' });
  const results = {};
  const record = (k, v) => (results[k] = v);

  const dev = await signer.device();
  assert.equal(deviceIdFor(dev.publicKey), dev.deviceId, 'deviceId = b64url(sha256(spki))');
  svc.pairDevice(dev.deviceId, dev.publicKey);
  const params = { requestId: 'rq_31c0', answer: '方案 B', n: 1.5 };

  // 1. 合法签名
  const c1 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  const s1 = await signer.sign(c1.challenge);
  assert.equal(s1.canonical, canonicalize({ domain: PRESENCE_DOMAIN, payload: c1.challenge }), 'canonical text equal');
  assert.equal(Buffer.from(s1.signature, 'base64url').length, 64, 'P1363 r||s = 64 bytes');
  const r1 = await svc.sign(c1.confirmationId, proofOf(s1));
  record('legit', r1);
  assert.equal(r1.ok, true);

  // 2. 重放：同一证明再次提交；把它用到另一条待确认上
  record('replay-same', await svc.sign(c1.confirmationId, proofOf(s1)));
  assert.equal(results['replay-same'].code, 'already_handled');
  const c2 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  record('replay-other-confirmation', await svc.sign(c2.confirmationId, proofOf(s1)));
  assert.equal(results['replay-other-confirmation'].code, 'bad_signature');

  // 3. 过期
  const c3 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params, ttlMs: 1000 });
  const s3 = await signer.sign(c3.challenge);
  clock += 1001;
  record('expired', await svc.sign(c3.confirmationId, proofOf(s3)));
  assert.equal(results.expired.code, 'expired');

  // 4. 参数被改：签名的挑战与保存的不同（target、paramsHash、action、expiresAt 各改一处）
  const c4 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  const tampered = {
    target: { ...c4.challenge, target: 'rq_other' },
    paramsHash: { ...c4.challenge, paramsHash: paramsHash({ ...params, answer: '方案 A' }) },
    action: { ...c4.challenge, action: 'agora.device.approve' },
    expiresAt: { ...c4.challenge, expiresAt: new Date(clock + 86400_000).toISOString() },
  };
  for (const [k, ch] of Object.entries(tampered)) {
    const s = await signer.sign(ch);
    record(`tampered-${k}`, await svc.sign(c4.confirmationId, proofOf(s)));
    assert.equal(results[`tampered-${k}`].code, 'bad_signature');
  }
  // 被拒的尝试不会作废这条待确认
  record('after-tamper-legit', await svc.sign(c4.confirmationId, proofOf(await signer.sign(c4.challenge))));
  assert.equal(results['after-tamper-legit'].ok, true);

  // 保存的请求参数在挑战生成后被改（第 5 步）
  const c5 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  svc.pending.get(c5.confirmationId).params.answer = '方案 C';
  record('stored-params-changed', await svc.sign(c5.confirmationId, proofOf(await signer.sign(c5.challenge))));
  assert.equal(results['stored-params-changed'].code, 'challenge_mismatch');

  // 签名字节被改
  const c6 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  const s6 = await signer.sign(c6.challenge);
  const flipped = Buffer.from(s6.signature, 'base64url');
  flipped[10] ^= 1;
  record('signature-bitflip', await svc.sign(c6.confirmationId, { ...proofOf(s6), signature: flipped.toString('base64url') }));
  assert.equal(results['signature-bitflip'].code, 'bad_signature');

  // 其他 domain 的签名
  const sDom = await signer.sign(c6.challenge, { domain: 'other-app/v1' });
  record('other-domain', await svc.sign(c6.confirmationId, proofOf(sDom)));
  assert.equal(results['other-domain'].code, 'bad_signature');

  // 不指定 ieee-p1363（按 Node 默认的 DER）验证同一个合法签名
  const s6ok = await signer.sign(c6.challenge);
  record('verify-p1363', verifyPresence({ publicKey: s6ok.publicKey, signature: s6ok.signature, payload: c6.challenge }));
  record('verify-der-default', verifyPresence({ publicKey: s6ok.publicKey, signature: s6ok.signature, payload: c6.challenge, dsaEncoding: 'der' }));
  assert.equal(results['verify-p1363'], true);
  assert.equal(results['verify-der-default'], false);

  // 5. 公钥不符：重置设备密钥后用新密钥签名
  const c7 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  const dev2 = await signer.reset();
  assert.notEqual(dev2.publicKey, dev.publicKey);
  const s7 = await signer.sign(c7.challenge);
  record('pk-mismatch-claim-old-id', await svc.sign(c7.confirmationId, { ...proofOf(s7), deviceId: dev.deviceId }));
  assert.equal(results['pk-mismatch-claim-old-id'].code, 'public_key_mismatch');
  record('unpaired-new-device', await svc.sign(c7.confirmationId, proofOf(s7)));
  assert.equal(results['unpaired-new-device'].code, 'device_not_paired');
  record('old-pk-new-signature', await svc.sign(c7.confirmationId, { ...proofOf(s7), deviceId: dev.deviceId, publicKey: dev.publicKey }));
  assert.equal(results['old-pk-new-signature'].code, 'bad_signature');
  record('bad-alg', await svc.sign(c7.confirmationId, { ...proofOf(s7), deviceId: dev.deviceId, publicKey: dev.publicKey, alg: 'ES256' }));
  assert.equal(results['bad-alg'].code, 'bad_alg');

  // 以下用新设备：先配对
  svc.pairDevice(dev2.deviceId, dev2.publicKey);

  // 6. 并发提交同一个合法签名：只有一次成功
  const c8 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  const s8 = await signer.sign(c8.challenge);
  const both = await Promise.all([svc.sign(c8.confirmationId, proofOf(s8)), svc.sign(c8.confirmationId, proofOf(s8))]);
  record('concurrent', both);
  assert.equal(both.filter((r) => r.ok).length, 1);
  assert.equal(both.find((r) => !r.ok).code, 'already_handled');

  // 7. nonce 已被使用（模拟数据库里出现重复 nonce 的待确认）
  const c9 = svc.create({ action: 'agora.request.answer', target: 'rq_31c0', params });
  const p9 = svc.pending.get(c9.confirmationId);
  p9.challenge = { ...p9.challenge, nonce: c8.challenge.nonce };
  record('nonce-used', await svc.sign(c9.confirmationId, proofOf(await signer.sign(p9.challenge))));
  assert.equal(results['nonce-used'].code, 'nonce_used');

  // 8. 目标状态已不允许
  const c10 = svc.create({ action: 'agora.request.answer', target: 'rq_closed', params });
  record('invalid-state', await svc.sign(c10.confirmationId, proofOf(await signer.sign(c10.challenge))));
  assert.equal(results['invalid-state'].code, 'invalid_state');

  // 9. JCS 刁钻 payload：签名方与验签方各自规范化
  const tp = trickyPayload();
  const sT = await signer.sign(tp);
  const nodeCanon = canonicalize({ domain: PRESENCE_DOMAIN, payload: tp });
  record('tricky-canonical-equal', sT.canonical === nodeCanon);
  record('tricky-verify', verifyPresence({ publicKey: sT.publicKey, signature: sT.signature, payload: tp }));
  assert.equal(results['tricky-canonical-equal'], true);
  assert.equal(results['tricky-verify'], true);

  assert.equal(svc.executed.length, 3, 'only legit, after-tamper-legit and one concurrent executed');
  record('executed', svc.executed.map((e) => e.id));
  record('auditDenied', svc.audit.filter((a) => a.result === 'denied').map((a) => `${a.step}:${a.reason}`));
  note?.('presence-scenarios', results);
  return results;
}
