import './utils/userDataPath';
/** 须尽早注册：若置于其它 ipc 之后，同目录其它模块在 import 阶段抛错会导致本段 handler 未执行 */
import './ipc/knowledge';
import { app, BrowserWindow, clipboard, globalShortcut, protocol } from 'electron';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

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
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed() && process.env.VITE_DEV_SERVER_URL)
      mainWindow.webContents.openDevTools();
  });

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

if (PRIMARY_INSTANCE) {
  app.on('second-instance', () => {
    focusMainWindowOrCreate();
  });

  app.whenReady().then(() => {
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
