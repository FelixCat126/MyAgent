import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
const REMOTE_SHELL_SRC = join(_dirname, 'electron/remote-shell.html');
const REMOTE_SHELL_OUT = join(_dirname, 'dist-electron/remote-shell.html');
const REMOTE_TOUCH_ICON_SRC = join(_dirname, 'electron/remote-apple-touch-icon.png');
const REMOTE_TOUCH_ICON_OUT = join(_dirname, 'dist-electron/remote-apple-touch-icon.png');
const REMOTE_MANIFEST_SRC = join(_dirname, 'electron/remote-manifest.webmanifest');
const REMOTE_MANIFEST_OUT = join(_dirname, 'dist-electron/remote-manifest.webmanifest');

/** 打包会错误地生成 ESM 的 `import`，而 Electron 对 preload 使用 require 加载，故原样复制 CJS 源文件。 */
function copyPreloadCjs() {
  mkdirSync(dirname(PRELOAD_OUT), { recursive: true });
  copyFileSync(PRELOAD_SRC, PRELOAD_OUT);
}

function copyRemoteShellHtml() {
  mkdirSync(dirname(REMOTE_SHELL_OUT), { recursive: true });
  copyFileSync(REMOTE_SHELL_SRC, REMOTE_SHELL_OUT);
  if (existsSync(REMOTE_TOUCH_ICON_SRC))
    copyFileSync(REMOTE_TOUCH_ICON_SRC, REMOTE_TOUCH_ICON_OUT);
  if (existsSync(REMOTE_MANIFEST_SRC))
    copyFileSync(REMOTE_MANIFEST_SRC, REMOTE_MANIFEST_OUT);
}

function electronPreloadCopyPlugin(): Plugin {
  return {
    name: 'electron-preload-cjs-copy',
    buildStart() {
      copyPreloadCjs();
      copyRemoteShellHtml();
    },
    configureServer() {
      copyPreloadCjs();
      copyRemoteShellHtml();
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
              /** ws 会通过 try/catch 加载可选原生模块；若不 external，打包会变成无法解析的静态 import */
              external: ['ws', 'bufferutil', 'utf-8-validate'],
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
          copyRemoteShellHtml();
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
