import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

// P0_HLJS=common|min|full 选择代码高亮的语言集合；输出到 P0_OUTDIR，未设置时为 dist-<variant>/。
const variant = process.env.P0_HLJS ?? 'common';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [preact()],
  resolve: {
    alias: { 'virtual-hljs': fileURLToPath(new URL(`./src/hljs-${variant}.js`, import.meta.url)) },
  },
  build: {
    outDir: process.env.P0_OUTDIR ?? `dist-${variant}`,
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
  },
  logLevel: 'warn',
});
