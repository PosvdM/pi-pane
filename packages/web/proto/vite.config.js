// 原型的独立 Vite 配置：入口为 proto/index.html，输出到 proto/dist，不进入正式构建和体积检查。
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true, modulePreload: { polyfill: false } },
  logLevel: "warn",
});
