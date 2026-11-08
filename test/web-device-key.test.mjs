import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { canonicalize, PRESENCE_DOMAIN } from "../packages/web/src/lib/jcs.ts";
import { trickyPayload } from "./fixtures/jcs-vectors.mjs";
import { until } from "./fixtures/helpers.mjs";
import { screenshot } from "./fixtures/browser.mjs";
import { setup, byId, observePage } from "./fixtures/web-e2e.mjs";

// 只读取生产库，不生成密钥、不创建存储，也不复制生产签名流程。
async function deviceProof(page, signingText) {
  return page.evaluate(async signingText => {
    if (!(await indexedDB.databases()).some(db => db.name === "pi-pane-device")) return null;
    const request = req => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const db = await request(indexedDB.open("pi-pane-device", 1));
    let record;
    try {
      if (!db.objectStoreNames.contains("keys")) throw new Error("生产库缺少 keys 存储");
      record = await request(db.transaction("keys", "readonly").objectStore("keys").get("device"));
    } finally { db.close(); }
    if (!record) return null;
    const { privateKey } = record;
    const exportErrors = {};
    for (const format of ["pkcs8", "jwk"]) {
      try { await crypto.subtle.exportKey(format, privateKey); exportErrors[format] = null; }
      catch (error) { exportErrors[format] = error.name; }
    }
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(signingText));
    return {
      signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
      publicKey: record.publicKey, deviceId: record.deviceId, createdAt: record.createdAt,
      extractable: privateKey.extractable, isCryptoKey: privateKey instanceof CryptoKey,
      keyType: privateKey.type, usages: privateKey.usages, algorithm: privateKey.algorithm, exportErrors,
    };
  }, signingText);
}
function verificationKey(publicKey) {
  return { key: createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" };
}

test("R8/R11 Chrome 首次配对即持久化生产私钥，设置 ID 与公钥及签名一致", { timeout: 60_000 }, async t => {
  const s = await setup(t, { turns: [] }); if (!s) return;
  const { page } = s;
  const payload = trickyPayload();
  const signingText = canonicalize({ domain: PRESENCE_DOMAIN, payload });
  assert.equal(await byId(page, "settings").count(), 0);
  const proof = await until(() => deviceProof(page, signingText));
  assert.equal(await byId(page, "settings").count(), 0, "配对后尚未打开设置时，生产库必须已有密钥");
  assert.equal(proof.isCryptoKey, true); assert.equal(proof.extractable, false);
  assert.equal(proof.keyType, "private"); assert.deepEqual(proof.usages, ["sign"]);
  assert.deepEqual(proof.algorithm, { name: "ECDSA", namedCurve: "P-256" });
  assert.deepEqual(proof.exportErrors, { pkcs8: "InvalidAccessError", jwk: "InvalidAccessError" });
  const spki = Buffer.from(proof.publicKey, "base64url");
  const signature = Buffer.from(proof.signature, "base64");
  assert.equal(signature.length, 64, "签名必须使用 IEEE P1363 的 r‖s 格式");
  assert.equal(proof.deviceId, createHash("sha256").update(spki).digest("base64url"));
  const key = verificationKey(proof.publicKey);
  assert.equal(verify("sha256", Buffer.from(signingText), key, signature), true);
  assert.equal(verify("sha256", Buffer.from(canonicalize({ domain: "其他域", payload })), key, signature), false);
  assert.equal(verify("sha256", Buffer.from(canonicalize({ domain: PRESENCE_DOMAIN, payload: { ...payload, target: "被修改" } })), key, signature), false);
  await byId(page, "open-settings").click();
  const device = byId(page, "device-id"); await device.waitFor();
  assert.equal(await device.textContent(), proof.deviceId.slice(0, 12) + "…");
  assert.equal(await device.getAttribute("title"), proof.deviceId, "设置显示的完整 ID 必须对应生产库中的公钥");
  await screenshot(page, "web-device-key");
  await page.reload(); await byId(page, "sidebar").waitFor();
  const persisted = await until(() => deviceProof(page, signingText));
  assert.equal(persisted.deviceId, proof.deviceId);
  assert.equal(persisted.publicKey, proof.publicKey); assert.equal(persisted.createdAt, proof.createdAt);
  assert.equal(persisted.extractable, false);
  assert.equal(verify("sha256", Buffer.from(signingText), key, Buffer.from(persisted.signature, "base64")), true);
});

test("R10 Chrome 两标签页同时初始化生产设备密钥时串行化且返回同一 ID", { timeout: 60_000 }, async t => {
  const s = await setup(t, { turns: [] }); if (!s) return;
  const { page, context } = s;
  await until(() => deviceProof(page, "初始化探针"));
  const other = observePage(await context.newPage()); s.pages.push(other); other.setDefaultTimeout(15_000);
  await other.goto(s.server.origin); await byId(other, "sidebar").waitFor();
  await until(() => deviceProof(other, "初始化探针"));
  const holder = await context.newPage();
  await holder.goto(s.server.origin + "/api/instance");
  let release; let held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await holder.exposeFunction("holdTestLock", async () => { held = true; await gate; });
  let holding;
  try {
    await holder.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase("pi-pane-device");
      req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("生产数据库仍有未关闭连接"));
    }));
    holding = holder.evaluate(() => navigator.locks.request("pi-pane-device-key", () => globalThis.holdTestLock()));
    await until(() => held);
    await Promise.all([page.reload(), other.reload()]);
    await Promise.all([byId(page, "sidebar").waitFor(), byId(other, "sidebar").waitFor()]);
    await Promise.all([byId(page, "open-settings").click(), byId(other, "open-settings").click()]);
    const pending = await until(async () => {
      const locks = await holder.evaluate(() => navigator.locks.query());
      return locks.pending.filter(lock => lock.name === "pi-pane-device-key").length >= 4 && locks;
    });
    assert.ok(pending.pending.length >= 4, "两个 Main 初始化与两个设置读取都必须等待同一把锁");
    assert.equal(await deviceProof(holder, "生成前探针"), null, "锁释放前不得旁路生成或覆盖密钥");
    release(); await holding;
    await Promise.all([byId(page, "device-id").waitFor(), byId(other, "device-id").waitFor()]);
    const proof = await deviceProof(page, "并发生成后的签名");
    const otherProof = await deviceProof(other, "并发生成后的签名");
    assert.equal(await byId(page, "device-id").getAttribute("title"), proof.deviceId);
    assert.equal(await byId(other, "device-id").getAttribute("title"), proof.deviceId);
    assert.equal(otherProof.deviceId, proof.deviceId); assert.equal(otherProof.publicKey, proof.publicKey);
    assert.equal(proof.extractable, false);
    assert.equal(proof.deviceId, createHash("sha256").update(Buffer.from(proof.publicKey, "base64url")).digest("base64url"));
  } finally { release(); await holding; await holder.close(); }
});

// Node 不提供 IndexedDB；适配器仅模拟只读事务事件，签名逻辑直接运行生产模块。
function readonlyDatabase(record) {
  return {
    open(name, version) {
      assert.equal(name, "pi-pane-device"); assert.equal(version, 1);
      const open = {};
      queueMicrotask(() => {
        open.result = {
          close() {},
          transaction(store, mode) {
            assert.equal(store, "keys"); assert.equal(mode, "readonly");
            const tx = { objectStore(name) {
              assert.equal(name, "keys");
              return { get(key) {
                assert.equal(key, "device");
                const req = {};
                queueMicrotask(() => { req.result = record(); req.onsuccess(); setImmediate(() => tx.oncomplete()); });
                return req;
              } };
            } };
            return tx;
          },
        };
        open.onsuccess();
      });
      return open;
    },
  };
}

test("R11 Node 直接调用生产 signPresence，核对默认域、JCS 字节、编码与缺失密钥", { timeout: 10_000 }, async t => {
  // Node 24 的原生类型擦除不支持 PresenceError 的参数属性，因此只在测试进程内转译完整源模块。
  const url = new URL("../packages/web/src/lib/device-key.ts", import.meta.url);
  const source = (await readFile(url, "utf8")).replace('"./jcs.ts"', JSON.stringify(new URL("../packages/web/src/lib/jcs.ts", import.meta.url).href));
  const output = stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url.href });
  const { signPresence, PresenceError } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  let record = { privateKey: pair.privateKey, publicKey: spki.toString("base64url"), deviceId: createHash("sha256").update(spki).digest("base64url"), createdAt: new Date().toISOString() };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: readonlyDatabase(() => record) });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor); else delete globalThis.indexedDB; });
  const payload = trickyPayload(); const key = verificationKey(record.publicKey);
  for (const domain of [undefined, "测试签名域"]) {
    const proof = domain === undefined ? await signPresence(payload) : await signPresence(payload, domain);
    assert.equal(proof.deviceId, record.deviceId); assert.equal(proof.publicKey, record.publicKey);
    assert.equal(proof.alg, "ECDSA-P256-SHA256"); assert.match(proof.signature, /^[A-Za-z0-9_-]+$/);
    const signature = Buffer.from(proof.signature, "base64url"); assert.equal(signature.length, 64);
    const bytes = Buffer.from(canonicalize({ domain: domain ?? PRESENCE_DOMAIN, payload }));
    assert.equal(verify("sha256", bytes, key, signature), true);
    assert.equal(verify("sha256", Buffer.from(canonicalize({ domain: "错误域", payload })), key, signature), false);
    assert.equal(verify("sha256", Buffer.from(canonicalize({ domain: domain ?? PRESENCE_DOMAIN, payload: { ...payload, target: "篡改" } })), key, signature), false);
  }
  record = undefined;
  await assert.rejects(signPresence(payload), error => error instanceof PresenceError && error.code === "noDevice");
  await assert.rejects(signPresence({ invalid: NaN }), /JCS|有限|finite/);
});
