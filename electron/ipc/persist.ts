import { ipcMain, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { writeFile, mkdir, unlink, readdir } from 'fs/promises';

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

ipcMain.handle('persist-state-get', async (_e, name: string) => {
  return readFileSyncOrNull(filePath(name));
});

ipcMain.handle('persist-state-set', async (_e, payload: { name: string; value: string }) => {
  const { name, value } = payload;
  const f = filePath(name);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, value, 'utf-8');
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
    event.returnValue = readFileSyncOrNull(filePath(name));
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('persist-state-set-sync', (_event, name: string, value: string) => {
  try {
    if (typeof name !== 'string' || !/^[a-z0-9._-]+$/i.test(name)) {
      return;
    }
    const f = filePath(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, value, 'utf-8');
  } catch (err) {
    console.error('[persist-state-set-sync]', err);
  }
});
