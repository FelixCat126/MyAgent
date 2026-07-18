import { ipcMain, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { writeFile, mkdir, unlink, readdir } from 'fs/promises';
import {
  protectPersistJsonText,
  revealPersistJsonText,
  revealPersistParsed,
} from '../utils/securePersist';

/**
 * 含敏感字段（API Key 等）的 persist 仓库：落盘前逐字段加密，读取时还原。
 * 仅小体量配置仓库启用；chat-storage 等大文件不做变换以避免流式期间的解析开销。
 */
const SECURE_PERSIST_NAMES = new Set([
  'model-storage',
  'web-search-storage',
  'knowledge-storage',
  'setting-storage',
]);

function persistDir(): string {
  return path.join(app.getPath('userData'), 'persist');
}

function filePath(name: string): string {
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    throw new Error('Invalid persist name');
  }
  return path.join(persistDir(), `${name}.json`);
}

function readFileSyncOrNull(f: string): string | null {
  try {
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return null;
  }
}

function readPersistTextSync(name: string): string | null {
  const raw = readFileSyncOrNull(filePath(name));
  if (raw == null) return null;
  return SECURE_PERSIST_NAMES.has(name) ? revealPersistJsonText(raw) : raw;
}

function writePersistTextSync(name: string, value: string): void {
  const f = filePath(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, SECURE_PERSIST_NAMES.has(name) ? protectPersistJsonText(value) : value, 'utf-8');
}

/** 主进程可读：供远端网关等在无渲染线程桥接时回填模型列表等 */
export function readPersistParsedSync(name: string): unknown | null {
  try {
    if (typeof name !== 'string' || !/^[a-z0-9._-]+$/i.test(name)) return null;
    const txt = readFileSyncOrNull(filePath(name));
    if (!txt) return null;
    const parsed = JSON.parse(txt) as unknown;
    return SECURE_PERSIST_NAMES.has(name) ? revealPersistParsed(parsed) : parsed;
  } catch {
    return null;
  }
}

ipcMain.handle('persist-state-get', async (_e, name: string) => {
  return readPersistTextSync(name);
});

ipcMain.handle('persist-state-set', async (_e, payload: { name: string; value: string }) => {
  const { name, value } = payload;
  const f = filePath(name);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, SECURE_PERSIST_NAMES.has(name) ? protectPersistJsonText(value) : value, 'utf-8');
});

ipcMain.handle('persist-state-remove', async (_e, name: string) => {
  const f = filePath(name);
  try {
    await unlink(f);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  }
});

ipcMain.handle('persist-state-clear-all', async () => {
  const dir = persistDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map((n) => unlink(path.join(dir, n)).catch(() => undefined))
  );
});

/** 引导等极少数字段：启动时同步读，避免首屏闪烁；禁止用于大体量数据 */
ipcMain.on('persist-state-get-sync', (event, name: string) => {
  try {
    if (typeof name !== 'string' || !/^[a-z0-9._-]+$/i.test(name)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = readPersistTextSync(name);
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('persist-state-set-sync', (_event, name: string, value: string) => {
  try {
    if (typeof name !== 'string' || !/^[a-z0-9._-]+$/i.test(name)) {
      return;
    }
    writePersistTextSync(name, value);
  } catch (err) {
    console.error('[persist-state-set-sync]', err);
  }
});
