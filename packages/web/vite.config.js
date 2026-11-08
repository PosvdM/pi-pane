import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    // CSP 不允许内联脚本；模块预加载的 polyfill 会注入内联代码，Chrome 原生支持 modulepreload。
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  logLevel: "warn",
});
