import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startServer } from "./client.mjs";

// 在 piFixture 隔离 HOME 等变量之前保留浏览器启动环境。
const browserEnv = { ...process.env };
export const webRoot = fileURLToPath(new URL("../../packages/web/dist/", import.meta.url));

export function chromePath() {
  return [
    process.env.CHROME_PATH, process.env.CHROME_BIN,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    browserEnv.LOCALAPPDATA && path.join(browserEnv.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    browserEnv.HOME && path.join(browserEnv.HOME, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome",
  ].find(file => file && existsSync(file));
}

export function requireChrome(t) {
  const executablePath = chromePath();
  if (executablePath) return executablePath;
  assert.notEqual(process.env.PANE_TEST_REQUIRE_CHROME, "1", "CI 必须安装并实际运行 Chrome");
  t.skip("本机未找到 Google Chrome，可通过 CHROME_PATH 或 CHROME_BIN 指定路径");
  return null;
}

export async function startWebServer(fixture, extra = {}) {
  if (!existsSync(path.join(webRoot, "index.html"))) throw new Error("缺少 packages/web/dist，请先 npm run build");
  return startServer(fixture, { ...extra, webRoot });
}

export async function launch(executablePath = chromePath()) {
  assert.ok(executablePath, "未找到 Google Chrome");
  return chromium.launch({ executablePath, env: browserEnv, headless: true, args: ["--no-proxy-server", "--no-sandbox"] });
}

export async function openPaired(browser, server, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  try {
    const page = await context.newPage();
    page.paneErrors = [];
    page.on("console", message => {
      if (message.type() === "error" || /Content Security Policy/i.test(message.text())) {
        page.paneErrors.push(`console: ${message.text()}`);
      }
    });
    page.on("pageerror", error => page.paneErrors.push(`pageerror: ${error.message}`));
    await page.goto(`${server.origin}/#code=${server.auth.issuePairCode()}`);
    await page.locator('[data-testid="sidebar"]').waitFor({ state: "visible" });
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export function assertNoPageErrors(page, whitelist = []) {
  const patterns = Array.isArray(whitelist) ? whitelist : [whitelist];
  assert.ok(Array.isArray(page.paneErrors), "页面必须通过 openPaired 建立错误收集器");
  const errors = page.paneErrors.filter(message => !patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(message);
  }));
  assert.deepEqual(errors, [], "页面不得出现未列入白名单的控制台、运行时或 CSP 错误");
}

export async function screenshot(page, name) {
  const directory = process.env.PANE_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}
