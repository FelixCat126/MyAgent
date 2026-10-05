import { app, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadImage } from '@napi-rs/canvas';
import { MediaVersionRepository } from '../media-workbench/versions';
let repository: MediaVersionRepository | undefined;
export function getMediaVersionRepository() { return repository ??= new MediaVersionRepository(path.join(app.getPath('userData'), 'media-workbench', 'versions.json')); }
ipcMain.handle('media-workbench-versions', async (_event, arg: { path: string }) => {
  try { if (!arg?.path || !path.isAbsolute(arg.path)) throw new Error('本地图片路径无效 / Invalid local image path'); return { ok: true, versions: await getMediaVersionRepository().family(arg.path) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('media-workbench-reference', async () => {
  const selected = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
  try {
    const source = selected.filePaths[0]; const stat = await fs.stat(source); if (stat.size > 25 * 1024 * 1024) throw new Error('参考图超过 25MB / Reference exceeds 25MB');
    const bytes = await fs.readFile(source); await loadImage(bytes); const directory = path.join(app.getPath('userData'), 'myagent-uploads'); await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${randomUUID()}${path.extname(source)}`); await fs.writeFile(target, bytes, { mode: 0o600 });
    return { ok: true, file: { name: path.basename(source), path: target, size: bytes.length, type: /\.jpe?g$/i.test(source) ? 'image/jpeg' : /\.webp$/i.test(source) ? 'image/webp' : 'image/png' } };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
