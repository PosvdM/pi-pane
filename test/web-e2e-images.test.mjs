import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readSession } from "../packages/server/dist/store.js";
import { screenshot } from "./fixtures/browser.mjs";
import { setup, byId, newSession, idle, replyScript } from "./fixtures/web-e2e.mjs";
import { until } from "./fixtures/helpers.mjs";

function png(red, green, blue) {
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

async function copyDraft(page) {
  return byId(page, "composer").evaluate(editor => {
    const range = document.createRange(); range.selectNodeContents(editor);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const data = new DataTransfer();
    editor.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    getSelection().collapseToEnd();
    return { text: data.getData("text/plain"), draft: data.getData("application/x-pi-pane-draft") };
  });
}

async function numberedChips(page, cdp, expected) {
  const styles = await byId(page, "composer").locator(".chip").evaluateAll(chips => chips.map(chip => ({
    content: getComputedStyle(chip, "::before").content,
    increment: getComputedStyle(chip).counterIncrement,
    ownText: chip.textContent,
  })));
  assert.equal(styles.length, expected.length);
  for (const style of styles) {
    // Chrome 的 CSSOM 保留 counter(image) 表达式；实际排版后的编号由可访问性树核对。
    assert.match(style.content, /\[Image #.*counter\(image\)/);
    assert.match(style.increment, /image/);
    assert.equal(style.ownText, "", "编号必须由 CSS 生成，不能写入 chip 的文本");
  }
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: '[data-testid="composer"] .chip' });
  const backendIds = await Promise.all(nodeIds.map(async nodeId => (await cdp.send("DOM.describeNode", { nodeId })).node.backendNodeId));
  const rendered = await until(async () => {
    const tree = await cdp.send("Accessibility.getFullAXTree");
    const nodes = new Map(tree.nodes.map(node => [node.nodeId, node]));
    const text = node => !node ? "" : node.role?.value === "StaticText" ? node.name.value : (node.childIds ?? []).map(id => text(nodes.get(id))).join("");
    const labels = backendIds.map(id => text(tree.nodes.find(node => node.backendDOMNodeId === id)));
    return JSON.stringify(labels) === JSON.stringify(expected) && labels;
  });
  assert.deepEqual(rendered, expected);
}

test("Chrome 两张图片占位符的上传、复制、发送和退格重新编号", { timeout: 90_000 }, async t => {
  const s = await setup(t, replyScript("图片收取完成")); if (!s) return;
  const { page, fixture, context } = s;
  await newSession(page, fixture);
  const editor = byId(page, "composer");
  const red = png(255, 0, 0); const blue = png(0, 0, 255);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.notEqual(hash(red), hash(blue));
  await editor.fill("第一张");
  await byId(page, "image-input").setInputFiles({ name: "red.png", mimeType: "image/png", buffer: red });
  await editor.locator(".chip").waitFor();
  await editor.press("ControlOrMeta+z");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer"] .chip').length === 0);
  await editor.press("ControlOrMeta+Shift+z");
  await editor.locator(".chip").waitFor();
  await editor.evaluate(el => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); // 光标移到末尾（不依赖平台快捷键）
  await page.keyboard.insertText("中间");
  await byId(page, "image-input").setInputFiles({ name: "blue.png", mimeType: "image/png", buffer: blue });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer"] .chip').length === 2);
  await editor.evaluate(el => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); // 光标移到末尾（不依赖平台快捷键）
  await page.keyboard.insertText("结尾");
  const ids = await editor.locator(".chip").evaluateAll(chips => chips.map(chip => chip.dataset.assetId));
  assert.notEqual(ids[0], ids[1], "两张不同的 PNG 必须产生不同资源");
  assert.deepEqual(ids, ["sha256-" + hash(red), "sha256-" + hash(blue)], "上传资源必须按顺序对应未缩放的红、蓝原图");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  await numberedChips(page, cdp, ["[Image #1]", "[Image #2]"]);
  const copied = await copyDraft(page);
  assert.equal(copied.text, "第一张[Image #1]中间[Image #2]结尾");
  assert.deepEqual(JSON.parse(copied.draft).map(node => node.type), ["text", "image", "text", "image", "text"]);
  await screenshot(page, "e2e-images-composer");
  await editor.press("Enter");
  await until(async () => {
    if (await byId(page, "trust-yes").isVisible()) await byId(page, "trust-yes").click();
    return byId(page, "model-button").isVisible();
  }, 30_000);
  await byId(page, "assistant-message").waitFor();
  const final = await idle(s);
  const disk = await readSession(final.sessionFile);
  const users = disk.entries.filter(entry => entry.message?.role === "user");
  assert.equal(users.length, 1);
  const content = users[0].message.content;
  assert.deepEqual(content.map(block => block.type), ["text", "image", "text", "image", "text"]);
  assert.deepEqual(content.filter(block => block.type === "text").map(block => block.text), ["第一张[Image #1]", "中间[Image #2]", "结尾"]);
  const images = content.filter(block => block.type === "image");
  assert.deepEqual(images.map(block => block.mimeType), ["image/png", "image/png"]);
  // 1×1 PNG 不经过缩放；磁盘中的两个数据块必须分别对应红、蓝上传原图。
  assert.deepEqual(images.map(block => hash(Buffer.from(block.data, "base64"))), [hash(red), hash(blue)], "[Image #1] 为红图，[Image #2] 为蓝图，交换图片字节必须失败");
  for (let i = 0; i < images.length; i++) {
    assert.equal(content[i * 2].text.endsWith(`[Image #${i + 1}]`), true);
    assert.equal(hash(Buffer.from(content[i * 2 + 1].data, "base64")), [hash(red), hash(blue)][i]);
  }
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-testid="user-message"] img')];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  assert.equal(await byId(page, "user-message").locator("img").count(), 2);
  await screenshot(page, "e2e-images-message");
  // 用同一复制数据恢复草稿，再通过浏览器原生退格删除第一张图片。
  await editor.evaluate((editor, draft) => {
    editor.focus();
    const data = new DataTransfer(); data.setData("application/x-pi-pane-draft", draft);
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, copied.draft);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer"] .chip').length === 2);
  await editor.evaluate(editor => {
    const range = document.createRange(); range.setStartAfter(editor.querySelector(".chip")); range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range); editor.focus();
  });
  await editor.press("Backspace");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer"] .chip').length === 1);
  assert.equal(await editor.locator(".chip").getAttribute("data-asset-id"), ids[1]);
  await numberedChips(page, cdp, ["[Image #1]"]);
  assert.equal((await copyDraft(page)).text, "第一张中间[Image #1]结尾");
  await editor.press("ControlOrMeta+z");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer"] .chip').length === 2);
  await numberedChips(page, cdp, ["[Image #1]", "[Image #2]"]);
  await editor.press("ControlOrMeta+Shift+z");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer"] .chip').length === 1);
  await numberedChips(page, cdp, ["[Image #1]"]);
  await screenshot(page, "e2e-images-renumbered");
  await cdp.detach();
});
