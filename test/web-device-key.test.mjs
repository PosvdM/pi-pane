import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { piFixture } from "./fixtures/helpers.mjs";
import { requireChrome, startWebServer, launch, openPaired, assertNoPageErrors, screenshot } from "./fixtures/browser.mjs";
import { canonicalize, PRESENCE_DOMAIN } from "../packages/web/src/lib/jcs.ts";
import { trickyPayload } from "./fixtures/jcs-vectors.mjs";

test("Chrome 在 CSP 下持久化不可导出的设备私钥，JCS 签名可由 Node 验证", { timeout: 60000 }, async t => {
  const executablePath = requireChrome(t);
  if (!executablePath) return;
  const fixture = await piFixture();
  let server; let browser; let context;
  try {
    server = await startWebServer(fixture);
    browser = await launch(executablePath);
    const paired = await openPaired(browser, server);
    context = paired.context;
    const { page } = paired;
    const payload = trickyPayload();
    const signingText = canonicalize({ domain: PRESENCE_DOMAIN, payload });
    // 打包产物不暴露源模块路径；直接核对与 device-key.ts 相同的 WebCrypto 和 IndexedDB 调用。
    const proof = await page.evaluate(async signingText => {
      const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      const open = async () => {
        const req = indexedDB.open("pane-device-key-test", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("keys");
        return request(req);
      };
      const transaction = async (mode, action) => {
        const db = await open();
        try {
          const tx = db.transaction("keys", mode);
          const done = new Promise((resolve, reject) => {
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
          });
          const value = await request(action(tx.objectStore("keys")));
          await done;
          return value;
        } finally { db.close(); }
      };
      const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
      await transaction("readwrite", store => store.put(pair.privateKey, "device"));
      // 关闭数据库后重新打开并读取，确保签名使用的是结构化克隆后的持久化密钥。
      const privateKey = await transaction("readonly", store => store.get("device"));
      const exportErrors = {};
      for (const format of ["pkcs8", "jwk"]) {
        try { await crypto.subtle.exportKey(format, privateKey); exportErrors[format] = null; }
        catch (error) { exportErrors[format] = error.name; }
      }
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(signingText));
      return {
        signature: b64url(signature), publicKey: b64url(spki),
        deviceId: b64url(await crypto.subtle.digest("SHA-256", spki)),
        extractable: privateKey.extractable, isCryptoKey: privateKey instanceof CryptoKey,
        keyType: privateKey.type, usages: privateKey.usages, exportErrors,
      };
    }, signingText);
    assert.equal(proof.isCryptoKey, true); assert.equal(proof.extractable, false);
    assert.equal(proof.keyType, "private"); assert.deepEqual(proof.usages, ["sign"]);
    assert.deepEqual(proof.exportErrors, { pkcs8: "InvalidAccessError", jwk: "InvalidAccessError" });
    const spki = Buffer.from(proof.publicKey, "base64url");
    const signature = Buffer.from(proof.signature, "base64url");
    assert.equal(signature.length, 64, "签名必须使用 IEEE P1363 的 r‖s 格式");
    assert.equal(proof.deviceId, createHash("sha256").update(spki).digest("base64url"));
    const key = { key: createPublicKey({ key: spki, format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" };
    assert.equal(verify("sha256", Buffer.from(signingText), key, signature), true);
    assert.equal(verify("sha256", Buffer.from(canonicalize({ domain: "其他域", payload })), key, signature), false);
    assert.equal(verify("sha256", Buffer.from(canonicalize({ domain: PRESENCE_DOMAIN, payload: { ...payload, target: "被修改" } })), key, signature), false);

    await page.locator('[data-testid="open-settings"]').click();
    const device = page.locator('[data-testid="device-id"]');
    await device.waitFor({ state: "visible" });
    assert.match((await device.textContent()).trim(), /^[A-Za-z0-9_-]{12}…$/);
    const frontendDeviceId = await device.getAttribute("title");
    assert.match(frontendDeviceId, /^[A-Za-z0-9_-]{43}$/);
    await screenshot(page, "web-device-key");
    assertNoPageErrors(page);
    t.diagnostic("Chrome 实际执行：" + browser.version());
  } finally {
    try { await context?.close(); }
    finally {
      try { await browser?.close(); }
      finally { try { await server?.close(); } finally { await fixture.cleanup(); } }
    }
  }
});
