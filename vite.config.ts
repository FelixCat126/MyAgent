import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

const _dirname = dirname(fileURLToPath(import.meta.url));
const PRELOAD_SRC = join(_dirname, 'electron/preload.cjs');
const PRELOAD_OUT = join(_dirname, 'dist-electron/preload.cjs');

/** 打包会错误地生成 ESM 的 `import`，而 Electron 对 preload 使用 require 加载，故原样复制 CJS 源文件。 */
function copyPreloadCjs() {
  mkdirSync(dirname(PRELOAD_OUT), { recursive: true });
  copyFileSync(PRELOAD_SRC, PRELOAD_OUT);
}

function electronPreloadCopyPlugin(): Plugin {
  return {
    name: 'electron-preload-cjs-copy',
    buildStart() {
      copyPreloadCjs();
    },
    configureServer() {
      copyPreloadCjs();
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    electronPreloadCopyPlugin(),
    electron([
      {
        // 主进程入口
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                manualChunks(id: string) {
                  if (id.includes('node_modules/exceljs')) return 'vendor-excel';
                  if (id.includes('node_modules/mammoth')) return 'vendor-mammoth';
                  if (id.includes('node_modules/axios')) return 'vendor-http';
                  return undefined;
                },
              },
            },
          },
        },
        onstart(options) {
          copyPreloadCjs();
          options.reload();
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  css: {
    postcss: './postcss.config.js',
  },
  server: {
    port: 5180,
    strictPort: true,
    /** electron-builder 输出目录在仓库内时会触发刷屏式热重载（如 LICENSES.chromium.html），开发时忽略 */
    watch: {
      ignored: ['**/release/**'],
    },
  },
});
