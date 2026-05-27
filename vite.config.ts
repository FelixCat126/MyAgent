import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
/** 与 electron-builder 桌面图标同源：优先 resources，其次 public（与 generate-app-icon 输出一致） */
const REMOTE_TOUCH_ICON_OUT = join(_dirname, 'dist-electron/remote-apple-touch-icon.png');
const REMOTE_MANIFEST_SRC = join(_dirname, 'electron/remote-manifest.webmanifest');
const REMOTE_MANIFEST_OUT = join(_dirname, 'dist-electron/remote-manifest.webmanifest');
const MEDIAPIPE_WASM_SRC = join(_dirname, 'node_modules/@mediapipe/tasks-vision/wasm');
const MEDIAPIPE_WASM_OUT = join(_dirname, 'dist/mediapipe-wasm');

function resolveDesktopIconForRemoteTouch(): string | null {
  const candidates = [
    join(_dirname, 'resources/icon.png'),
    join(_dirname, 'public/icon.png'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 打包会错误地生成 ESM 的 `import`，而 Electron 对 preload 使用 require 加载，故原样复制 CJS 源文件。 */
function copyPreloadCjs() {
  mkdirSync(dirname(PRELOAD_OUT), { recursive: true });
  copyFileSync(PRELOAD_SRC, PRELOAD_OUT);
}

/** 把 MediaPipe Tasks Vision 的 wasm/JS 资源复制到 `dist/mediapipe-wasm/`，
 *  使 FilesetResolver 在 Electron 离线运行时能从同源相对路径加载，避免依赖外网。 */
function copyMediapipeWasm() {
  if (!existsSync(MEDIAPIPE_WASM_SRC)) {
    console.warn(
      '[vite] 未找到 @mediapipe/tasks-vision/wasm，跳过复制；手势识别功能将不可用'
    );
    return;
  }
  mkdirSync(MEDIAPIPE_WASM_OUT, { recursive: true });
  for (const f of readdirSync(MEDIAPIPE_WASM_SRC)) {
    copyFileSync(join(MEDIAPIPE_WASM_SRC, f), join(MEDIAPIPE_WASM_OUT, f));
  }
}

function copyRemoteShellHtml() {
  mkdirSync(dirname(REMOTE_SHELL_OUT), { recursive: true });
  copyFileSync(REMOTE_SHELL_SRC, REMOTE_SHELL_OUT);
  const iconSrc = resolveDesktopIconForRemoteTouch();
  if (iconSrc) {
    copyFileSync(iconSrc, REMOTE_TOUCH_ICON_OUT);
  } else {
    console.warn(
      '[vite] 未找到 resources/icon.png 或 public/icon.png，跳过复制 remote-apple-touch-icon（iOS 主屏幕图标将缺失）'
    );
  }
  if (existsSync(REMOTE_MANIFEST_SRC))
    copyFileSync(REMOTE_MANIFEST_SRC, REMOTE_MANIFEST_OUT);
}

function electronPreloadCopyPlugin(): Plugin {
  return {
    name: 'electron-preload-cjs-copy',
    buildStart() {
      copyPreloadCjs();
      copyRemoteShellHtml();
      copyMediapipeWasm();
    },
    /**
     * vite 默认 emptyOutDir=true，会在 buildStart 之后清空 dist；
     * mediapipe-wasm 需要进入最终 dist/，必须在产物写出后再复制一次。
     */
    writeBundle() {
      copyMediapipeWasm();
    },
    configureServer(server) {
      copyPreloadCjs();
      copyRemoteShellHtml();
      copyMediapipeWasm();
      /**
       * dev 模式不会预先生成 dist/mediapipe-wasm/，渲染端的 FilesetResolver
       * 又必须能从同源 URL 拉到 wasm 与 JS；这里通过 middleware 把
       * `/mediapipe-wasm/*` 直接代理到 node_modules 内，开发态零配置可用。
       */
      server.middlewares.use('/mediapipe-wasm', (req, res, next) => {
        try {
          const reqPath = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
          if (!reqPath) {
            next();
            return;
          }
          const filePath = join(MEDIAPIPE_WASM_SRC, reqPath);
          if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            next();
            return;
          }
          const isWasm = filePath.endsWith('.wasm');
          res.setHeader(
            'Content-Type',
            isWasm ? 'application/wasm' : 'application/javascript; charset=utf-8'
          );
          res.setHeader('Cache-Control', 'no-cache');
          createReadStream(filePath).pipe(res);
        } catch {
          next();
        }
      });
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
