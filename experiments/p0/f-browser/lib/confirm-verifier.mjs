// agora daemon 用户确认验签原型（agora P0 #16），按 pi-agora docs/security.md“用户确认”一节：
// 挑战 { action, target, paramsHash, nonce, expiresAt }，浏览器签 {domain:"pi-pane/user-presence/v1", payload: 挑战}
// 的 RFC 8785 规范 JSON；daemon 用 Node.js crypto.verify 并指定 dsaEncoding: "ieee-p1363"。
// 验签按 security.md“验签”的 1–6 步依次检查，任何一步失败都拒绝并写审计。
import { createHash, createPublicKey, randomBytes, verify as nodeVerify } from 'node:crypto';
import { canonicalize, presenceSigningBytes, PRESENCE_DOMAIN } from '../public/jcs.js';

export const ALG = 'ECDSA-P256-SHA256';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function paramsHash(params) {
  return b64url(createHash('sha256').update(canonicalize(params), 'utf8').digest());
}

export function deviceIdFor(publicKeyB64url) {
  return b64url(createHash('sha256').update(Buffer.from(publicKeyB64url, 'base64url')).digest());
}

/** 只验签名本身。dsaEncoding 可改为 'der' 以观察默认编码下的行为。 */
export function verifyPresence({ publicKey, signature, payload, domain = PRESENCE_DOMAIN, dsaEncoding = 'ieee-p1363' }) {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
  const data = presenceSigningBytes(payload, domain);
  try {
    return nodeVerify('sha256', data, { key, dsaEncoding }, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

const tick = () => new Promise((r) => setImmediate(r)); // 模拟数据库读写的异步间隙

export class ConfirmationService {
  constructor({ now = () => Date.now(), canExecute = () => true } = {}) {
    this.now = now;
    this.canExecute = canExecute; // 第 6 步：目标对象的当前状态是否仍允许该操作
    this.pending = new Map(); // confirmationId -> { id, action, target, params, challenge, status }
    this.usedNonces = new Set();
    this.devices = new Map(); // deviceId -> { publicKey }
    this.audit = [];
    this.executed = [];
  }

  pairDevice(deviceId, publicKey) {
    this.devices.set(deviceId, { publicKey });
  }

  /** 用户级请求到达：生成挑战，与完整请求参数一起存为待确认。 */
  create({ action, target, params, ttlMs = 5 * 60_000 }) {
    const id = 'cf_' + randomBytes(6).toString('hex');
    const challenge = {
      action,
      target,
      paramsHash: paramsHash(params),
      nonce: b64url(randomBytes(16)),
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
    };
    this.pending.set(id, { id, action, target, params: structuredClone(params), challenge, status: 'pending' });
    return { confirmationId: id, challenge };
  }

  #reject(id, body, step, status, code) {
    this.audit.push({ confirmationId: id, deviceId: body?.deviceId, result: 'denied', step, reason: code });
    return { ok: false, status, code, step };
  }

  /** POST /v1/confirmations/:id/sign { deviceId, publicKey, alg, signature } */
  async sign(id, body) {
    // 1. 待确认存在、状态为 pending、未过期
    await tick();
    const p = this.pending.get(id);
    if (!p) return this.#reject(id, body, 1, 404, 'not_found');
    if (p.status !== 'pending') return this.#reject(id, body, 1, 409, 'already_handled');
    if (Date.parse(p.challenge.expiresAt) <= this.now()) {
      p.status = 'expired';
      return this.#reject(id, body, 1, 410, 'expired');
    }
    // 2. nonce 未被使用过
    if (this.usedNonces.has(p.challenge.nonce)) return this.#reject(id, body, 2, 409, 'nonce_used');
    // 3. 已配对设备，且请求中的公钥与配对时记录的一致
    await tick();
    const dev = this.devices.get(body?.deviceId);
    if (!dev) return this.#reject(id, body, 3, 403, 'device_not_paired');
    if (dev.publicKey !== body.publicKey) return this.#reject(id, body, 3, 403, 'public_key_mismatch');
    if (body.alg !== ALG) return this.#reject(id, body, 3, 400, 'bad_alg');
    // 4. 签名有效（以记录的公钥、保存的挑战为准，不使用请求里的任何挑战内容）
    if (!verifyPresence({ publicKey: dev.publicKey, signature: body.signature, payload: p.challenge })) {
      return this.#reject(id, body, 4, 403, 'bad_signature');
    }
    // 5. 挑战的 action、target、paramsHash 与待确认中保存的请求一致
    if (p.challenge.action !== p.action || p.challenge.target !== p.target || p.challenge.paramsHash !== paramsHash(p.params)) {
      return this.#reject(id, body, 5, 409, 'challenge_mismatch');
    }
    // 6. 目标对象的当前状态仍允许该操作
    await tick();
    if (!this.canExecute(p)) return this.#reject(id, body, 6, 409, 'invalid_state');
    // 提交：同步完成“检查状态 + 消费 nonce + 标记 confirmed + 写审计”，相当于同一事务。
    if (p.status !== 'pending' || this.usedNonces.has(p.challenge.nonce)) {
      return this.#reject(id, body, 'commit', 409, 'already_handled');
    }
    this.usedNonces.add(p.challenge.nonce);
    p.status = 'confirmed';
    this.executed.push({ id, action: p.action, target: p.target, params: p.params, as: 'user' });
    this.audit.push({ confirmationId: id, deviceId: body.deviceId, result: 'allowed' });
    return { ok: true, status: 200 };
  }
}
