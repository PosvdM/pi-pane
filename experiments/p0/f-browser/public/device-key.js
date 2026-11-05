// pi-pane 设备密钥原型（plugin-api.md“设备密钥”“签名格式”）。
// 不可导出的 ECDSA P-256 私钥存在 IndexedDB；签名对象为 {domain, payload} 的 RFC 8785 规范 JSON。
import { canonicalize, b64url, PRESENCE_DOMAIN } from './jcs.js';

const DB_NAME = 'pi-pane-device';
const STORE = 'keys';
const KEY = 'device';
export const ALG = 'ECDSA-P256-SHA256';

export class PresenceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 检查运行环境；不支持时返回原因。 */
export function detectSupport() {
  if (!globalThis.isSecureContext) return { ok: false, reason: 'insecure-context' };
  if (!globalThis.crypto?.subtle) return { ok: false, reason: 'no-crypto-subtle' };
  if (!globalThis.indexedDB) return { ok: false, reason: 'no-indexeddb' };
  return { ok: true };
}

function idb(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function openDb() {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return idb(req);
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    const t = db.transaction(STORE, mode);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    });
    const result = await fn(t.objectStore(STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

async function describe(record) {
  return {
    deviceId: record.deviceId,
    publicKey: record.publicKey,
    alg: ALG,
    createdAt: record.createdAt,
  };
}

async function generate() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const deviceId = b64url(await crypto.subtle.digest('SHA-256', spki));
  return { privateKey: pair.privateKey, publicKey: b64url(spki), deviceId, createdAt: new Date().toISOString() };
}

function wrap(stage, e) {
  if (e instanceof PresenceError) return e;
  return new PresenceError('unsupported', `${stage}: ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
}

/** 读取已有设备密钥，没有时生成并存入 IndexedDB。存储失败（如浏览器不允许存 CryptoKey）按 unsupported 处理。 */
export async function getOrCreateDevice() {
  const sup = detectSupport();
  if (!sup.ok) throw new PresenceError('unsupported', sup.reason);
  let rec;
  try {
    rec = await tx('readonly', (s) => idb(s.get(KEY)));
  } catch (e) {
    throw wrap('idb-read', e);
  }
  if (rec) return { ...(await describe(rec)), created: false };
  let fresh;
  try {
    fresh = await generate();
  } catch (e) {
    throw wrap('generateKey', e);
  }
  try {
    await tx('readwrite', (s) => idb(s.put(fresh, KEY)));
    rec = await tx('readonly', (s) => idb(s.get(KEY)));
  } catch (e) {
    throw wrap('idb-write', e);
  }
  if (!rec || !(rec.privateKey instanceof CryptoKey)) throw new PresenceError('unsupported', 'idb-roundtrip: CryptoKey not restored');
  return { ...(await describe(rec)), created: true };
}

/** “重置设备密钥”：删除旧密钥后生成新的。 */
export async function resetDevice() {
  await tx('readwrite', (s) => idb(s.delete(KEY)));
  return getOrCreateDevice();
}

async function loadPrivateKey() {
  const rec = await tx('readonly', (s) => idb(s.get(KEY)));
  if (!rec) throw new PresenceError('noDevice', 'no device key');
  return rec;
}

/** 对任意字节签名（实验用，用于构造跨 domain 等反例）。 */
export async function signBytes(bytes) {
  const rec = await loadPrivateKey();
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.privateKey, bytes);
  return { deviceId: rec.deviceId, publicKey: rec.publicKey, alg: ALG, signature: b64url(sig), sigLength: sig.byteLength };
}

/** userPresence 签名：返回 UserPresenceProof，另附规范 JSON 文本便于和 Node 侧比对。 */
export async function signPresence(payload, { domain = PRESENCE_DOMAIN } = {}) {
  const canonical = canonicalize({ domain, payload });
  const proof = await signBytes(new TextEncoder().encode(canonical));
  return { ...proof, canonical };
}

/** 检查私钥的属性：是否可导出、导出是否被拒。 */
export async function inspectPrivateKey() {
  const rec = await loadPrivateKey();
  const k = rec.privateKey;
  const out = { extractable: k.extractable, type: k.type, algorithm: k.algorithm, usages: k.usages, exports: {} };
  for (const fmt of ['pkcs8', 'jwk', 'raw']) {
    try {
      await crypto.subtle.exportKey(fmt, k);
      out.exports[fmt] = 'EXPORTED';
    } catch (e) {
      out.exports[fmt] = `${e.name}`;
    }
  }
  return out;
}
