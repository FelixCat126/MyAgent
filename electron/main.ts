import './utils/userDataPath';
/** 须尽早注册：若置于其它 ipc 之后，同目录其它模块在 import 阶段抛错会导致本段 handler 未执行 */
import './ipc/knowledge';
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, protocol, session } from 'electron';
import path from 'path';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import './ipc/model';
import './ipc/model-stream';
import './ipc/export';
import './ipc/file';
import './ipc/documents';
import './ipc/image-gen';
import './ipc/web-search';
import './ipc/persist';
import './ipc/media-library';
import './ipc/speech-transcribe';
import './ipc/volc-stream-asr';
/** 应用启动器：模块内通过副作用注册 `launch-app` / `get-installed-apps` 两个 IPC 通道，
 *  渲染端（ChatWindow → window.electron.launchApp）依赖之；必须在 createWindow 之前完成注册 */
import './utils/app-launcher';
import {
  attachRemoteGatewayMainWindow,
  bootstrapRemoteGatewayFromDisk,
} from './ipc/remote-gateway';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

/**
 * Chromium NetworkService 会把部分系统/代理层 TLS reset 直接写 stderr，
 * 典型为 ssl_client_socket_impl.cc + net_error -100。它通常不是业务异常，
 * 且会在 dev 终端刷屏；保留应用自己的 console.warn/error 即可。
 */
if (process.env.MYAGENT_CHROMIUM_VERBOSE_LOGS !== '1') {
  app.commandLine.appendSwitch('log-level', '3');
  app.commandLine.appendSwitch('disable-logging');
}

const PRIMARY_INSTANCE = app.requestSingleInstanceLock();

if (!PRIMARY_INSTANCE) {
  app.quit();
}

function focusMainWindowOrCreate(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const fallback = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (fallback) {
    if (fallback.isMinimized()) fallback.restore();
    fallback.show();
    fallback.focus();
    return;
  }
  createWindow();
}

function createWindow() {
  const iconPath = path.join(__dirname, '../resources/icon.png');
  const icon = fsSync.existsSync(iconPath) ? iconPath : undefined;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    ...(icon ? { icon } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'MyAgent - AI助手',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false,
      /** 先于页面脚本执行：修补 ipcRenderer + 注入 window.electron（见 preload.cjs） */
      preload: path.join(__dirname, 'preload.cjs'),
    },
    show: false,
  });

  /** 避免出现长时间白屏错觉；内容就绪后再显式展示 */
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.send('window-focus-changed', true);
  });

  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-changed', true);
  });
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-changed', false);
  });
  mainWindow.on('show', () => {
    if (mainWindow?.isFocused()) {
      mainWindow.webContents.send('window-focus-changed', true);
    }
  });

  if (process.env.VITE_DEV_SERVER_URL && process.env.MYAGENT_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools();
    });
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /** 渲染进程脚本异常时兜底记录，便于排查分发版问题（无敏感内容） */
  mainWindow.webContents.on('preload-error', (_e, pathPreload, error) => {
    console.warn('[MyAgent] preload error', pathPreload, error);
  });
}

/**
 * 一次性读取 MediaPipe 模型字节流交给渲染端。
 *  Tasks Vision 直接支持 modelAssetBuffer (Uint8Array)，避免渲染端 fetch
 *  自定义协议带来的 cross-scheme / CORS / fetch API 兼容性问题。
 *  打包后通过 extraResources 落到 `Contents/Resources/models/`，开发态从仓库 resources/ 读取。
 */
async function readMediapipeModel(fileName: string) {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, `models/${fileName}`));
  }
  candidates.push(path.join(__dirname, `../resources/models/${fileName}`));
  candidates.push(path.join(app.getAppPath(), `resources/models/${fileName}`));
  for (const p of candidates) {
    try {
      const buf = await fs.readFile(p);
      /** IPC 序列化对 Buffer 友好（v8 序列化为 Uint8Array），渲染端可直接拿到 .buffer */
      return { ok: true as const, data: new Uint8Array(buf), path: p };
    } catch {
      /* try next */
    }
  }
  return { ok: false as const, error: `${fileName} not found` };
}

ipcMain.handle('get-gesture-model-data', () => readMediapipeModel('gesture_recognizer.task'));
ipcMain.handle('get-face-model-data', () => readMediapipeModel('face_landmarker.task'));

function parseGazeCoords(x: unknown, y: unknown): { ix: number; iy: number } | null {
  const ix = Math.round(Number(x));
  const iy = Math.round(Number(y));
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) return null;
  return { ix, iy };
}

/** 将虚拟指针移到视口坐标，Chromium 会据此更新 :hover / mouseenter 等命中态 */
function sendGazePointerMove(win: BrowserWindow, ix: number, iy: number) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: ix, y: iy });
}

/** 视线跟随：持续同步指针位置以触发 hover（仅当主窗口已聚焦时由渲染端调用，避免抢其它应用焦点） */
ipcMain.handle('simulate-gaze-move', async (_evt, x: number, y: number) => {
  try {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return { ok: false as const, error: 'no-window' };
    if (!win.isFocused()) return { ok: false as const, error: 'window-unfocused' };
    const coords = parseGazeCoords(x, y);
    if (!coords) return { ok: false as const, error: 'invalid-coords' };
    sendGazePointerMove(win, coords.ix, coords.iy);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error)?.message || String(e) };
  }
});

/** 视线单眨：在渲染端给出的视口坐标处模拟左键点击（仅作用于本窗口 webContents） */
ipcMain.handle('simulate-gaze-click', async (_evt, x: number, y: number) => {
  try {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return { ok: false as const, error: 'no-window' };
    if (!win.isFocused()) return { ok: false as const, error: 'window-unfocused' };
    const coords = parseGazeCoords(x, y);
    if (!coords) return { ok: false as const, error: 'invalid-coords' };
    const { ix, iy } = coords;
    sendGazePointerMove(win, ix, iy);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: ix, y: iy, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: ix, y: iy, button: 'left', clickCount: 1 });
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error)?.message || String(e) };
  }
});

/** 剪刀手上下划：在视口坐标处模拟滚轮（仅主窗口聚焦时） */
ipcMain.handle('simulate-gaze-wheel', async (_evt, x: number, y: number, deltaY: number) => {
  try {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return { ok: false as const, error: 'no-window' };
    if (!win.isFocused()) return { ok: false as const, error: 'window-unfocused' };
    const coords = parseGazeCoords(x, y);
    if (!coords) return { ok: false as const, error: 'invalid-coords' };
    const dy = Math.round(Number(deltaY));
    if (!Number.isFinite(dy) || dy === 0) return { ok: false as const, error: 'invalid-delta' };
    const { ix, iy } = coords;
    sendGazePointerMove(win, ix, iy);
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: ix,
      y: iy,
      deltaX: 0,
      deltaY: dy,
      wheelTicksX: 0,
      wheelTicksY: dy > 0 ? 1 : -1,
      accelerationRatioX: 1,
      accelerationRatioY: 1,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
    });
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error)?.message || String(e) };
  }
});

/**
 * 手势"双手前推"触发的截图：抓取主窗口当前视区 → PNG → 写入系统剪贴板。
 * 写剪贴板而非保存文件，避免后台目录/权限弹窗；同时和 Cmd+Shift+4 体验对齐。
 * 失败时返回 ok:false 由调用方决定是否提示。
 */
ipcMain.handle('capture-page-to-clipboard', async () => {
  try {
    const { BrowserWindow, clipboard } = await import('electron');
    const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    if (!target) return { ok: false as const, error: 'no-window' };
    const image = await target.webContents.capturePage();
    clipboard.writeImage(image);
    return { ok: true as const, width: image.getSize().width, height: image.getSize().height };
  } catch (e) {
    return { ok: false as const, error: (e as Error)?.message || String(e) };
  }
});

if (PRIMARY_INSTANCE) {
  app.on('second-instance', () => {
    focusMainWindowOrCreate();
  });

  app.whenReady().then(() => {
    /** 语音识别：放行麦克风权限（否则 Web Speech API 不可用）*/
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'media') {
        callback(true);
      } else {
        callback(false);
      }
    });

    if (process.env.MYAGENT_LOG_WEB_REQUESTS === '1') {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        try {
          const u = new URL(details.url);
          if (u.protocol === 'https:' || u.protocol === 'http:') {
            console.log('[MyAgent webRequest]', details.resourceType, `${u.protocol}//${u.host}${u.pathname}`);
          }
        } catch {
          /* ignore */
        }
        callback({});
      });
    }

    protocol.handle('local-file', async (request) => {
      try {
        /** 与 pathToFileURL 成对解析，避免手写 replace 在编码/Windows 盘符下出错 */
        const asFileUrl = request.url.trim().replace(/^local-file:/i, 'file:');
        const filePath = fileURLToPath(asFileUrl);
        /** 历史会话常指向已清理的临时路径，避免 ENOENT 刷满控制台 */
        if (!fsSync.existsSync(filePath)) {
          return new Response(null, { status: 404 });
        }
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        const mimeType = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf',
        }[ext.toLowerCase()] || 'application/octet-stream';

        return new Response(data, {
          headers: { 'Content-Type': mimeType },
        });
      } catch (error: unknown) {
        const er = error as { code?: string };
        if (er?.code !== 'ENOENT') {
          console.error('Error loading local file:', error);
        }
        return new Response(null, { status: 404 });
      }
    });

    createWindow();
    attachRemoteGatewayMainWindow(() => mainWindow);
    void bootstrapRemoteGatewayFromDisk().catch((err) => {
      console.error('[RemoteGateway] 启动网关失败:', err);
    });

    const pasteHotkey =
      process.platform === 'darwin' ? 'Command+Option+V' : 'CommandOrControl+Shift+V';
    const registered = globalShortcut.register(pasteHotkey, () => {
      const text = clipboard.readText();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('myagent-clipboard-paste', text);
      }
    });
    if (!registered) {
      console.warn('[MyAgent] 全局快捷键未注册:', pasteHotkey);
    }

    app.on('will-quit', () => {
      globalShortcut.unregisterAll();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  /** 渲染进程崩溃后自动拉起空窗，便于用户从历史恢复（持久化不受影响） */
  app.on('web-contents-created', (_e, wc) => {
    wc.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit')
        console.error('[MyAgent] render-process-gone:', details.reason, details.exitCode);
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
