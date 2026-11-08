// 设备密钥（plugin-api.md“设备密钥”“签名格式”）：WebCrypto 生成不可导出的 ECDSA P-256 私钥，存入 IndexedDB。
// 页面脚本只能用它签名。确认流程（userPresence）在 M3 接入；这里只提供密钥管理和签名。
import { b64url, presenceSigningBytes, PRESENCE_DOMAIN } from "./jcs.ts";

const DB_NAME = "pi-pane-device";
const STORE = "keys";
const KEY = "device";
const LABEL_KEY = "pi-pane.deviceLabel";
export const ALG = "ECDSA-P256-SHA256" as const;

export class PresenceError extends Error {
  constructor(readonly code: "unsupported" | "noDevice" | "rejected" | "timeout", message: string) { super(message); }
}

export interface DeviceInfo { deviceId: string; publicKey: string; alg: typeof ALG; createdAt: string; label: string }
export interface PresenceProof { deviceId: string; publicKey: string; alg: typeof ALG; signature: string }
interface KeyRecord { privateKey: CryptoKey; publicKey: string; deviceId: string; createdAt: string }

export function detectSupport(): { ok: true } | { ok: false; reason: string } {
  if (!globalThis.isSecureContext) return { ok: false, reason: "当前页面不是安全上下文" };
  if (!globalThis.crypto?.subtle) return { ok: false, reason: "浏览器不支持 WebCrypto" };
  if (!globalThis.indexedDB) return { ok: false, reason: "浏览器不支持 IndexedDB" };
  return { ok: true };
}

function idb<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function transaction<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await idb(open);
  try {
    const t = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error ?? new Error("事务中止"));
    });
    const result = await fn(t.objectStore(STORE));
    await done;
    return result;
  } finally { db.close(); }
}

function describe(record: KeyRecord): DeviceInfo {
  return { deviceId: record.deviceId, publicKey: record.publicKey, alg: ALG, createdAt: record.createdAt, label: localStorage.getItem(LABEL_KEY) ?? "本机 Chrome" };
}

async function generate(): Promise<KeyRecord> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: b64url(spki), deviceId: b64url(await crypto.subtle.digest("SHA-256", spki)), createdAt: new Date().toISOString() };
}

function unsupported(stage: string, error: unknown): PresenceError {
  if (error instanceof PresenceError) return error;
  return new PresenceError("unsupported", `${stage}：${(error as Error)?.message ?? error}`);
}

/** 读取设备密钥，没有时生成并存入 IndexedDB。 */
export async function getOrCreateDevice(): Promise<DeviceInfo> {
  const support = detectSupport();
  if (!support.ok) throw new PresenceError("unsupported", support.reason);
  let record: KeyRecord | undefined;
  try { record = await transaction("readonly", (s) => idb(s.get(KEY))); } catch (e) { throw unsupported("读取设备密钥", e); }
  if (record) return describe(record);
  try {
    const fresh = await generate();
    await transaction("readwrite", (s) => idb(s.put(fresh, KEY)));
    record = await transaction("readonly", (s) => idb(s.get(KEY)));
  } catch (e) { throw unsupported("生成设备密钥", e); }
  if (!record || !(record.privateKey instanceof CryptoKey)) throw new PresenceError("unsupported", "浏览器无法保存不可导出的密钥");
  return describe(record);
}

/** “重置设备密钥”：删除旧密钥并生成新的，插件后台服务会把它当作新设备。 */
export async function resetDevice(): Promise<DeviceInfo> {
  await transaction("readwrite", (s) => idb(s.delete(KEY)));
  return getOrCreateDevice();
}

export function setDeviceLabel(label: string): void { localStorage.setItem(LABEL_KEY, label.trim() || "本机 Chrome"); }

/** 对 {domain, payload} 的规范 JSON 签名，签名为 IEEE P1363（r‖s）格式的 base64url。 */
export async function signPresence(payload: unknown, domain = PRESENCE_DOMAIN): Promise<PresenceProof> {
  const bytes = presenceSigningBytes(payload, domain);
  let record: KeyRecord | undefined;
  try { record = await transaction("readonly", (s) => idb(s.get(KEY))); } catch (e) { throw unsupported("读取设备密钥", e); }
  if (!record) throw new PresenceError("noDevice", "本浏览器还没有设备密钥");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, record.privateKey, bytes);
  return { deviceId: record.deviceId, publicKey: record.publicKey, alg: ALG, signature: b64url(signature) };
}
