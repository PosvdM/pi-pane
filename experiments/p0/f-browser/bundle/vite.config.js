import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

// P0_HLJS=common|min|full 选择代码高亮的语言集合；输出到 dist-<variant>/。
const variant = process.env.P0_HLJS ?? 'common';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [preact()],
  resolve: {
    alias: { 'virtual-hljs': fileURLToPath(new URL(`./src/hljs-${variant}.js`, import.meta.url)) },
  },
  build: {
    outDir: `dist-${variant}`,
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
  },
  logLevel: 'warn',
});
