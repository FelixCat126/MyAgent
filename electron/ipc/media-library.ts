import { ipcMain, app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function generatedImagesDir(): string {
  return path.join(app.getPath('documents'), 'MyAgent', 'GeneratedImages');
}

function uploadsDir(): string {
  return path.join(app.getPath('userData'), 'myagent-uploads');
}

async function addImageFileToMap(full: string, map: Map<string, number>): Promise<void> {
  const ext = path.extname(full).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return;
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return;
    const key = path.normalize(full);
    const prev = map.get(key);
    map.set(key, prev === undefined ? st.mtimeMs : Math.max(prev, st.mtimeMs));
  } catch {
    /* 文件已删或不可读 */
  }
}

async function walkImageDir(dir: string, map: Map<string, number>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkImageDir(full, map);
    } else {
      await addImageFileToMap(full, map);
    }
  }
}

ipcMain.handle(
  'list-media-library-images',
  async (_evt, payload?: { extraPaths?: string[] } | null) => {
    try {
      const map = new Map<string, number>();

      await walkImageDir(generatedImagesDir(), map);
      await walkImageDir(uploadsDir(), map);

      const extras = Array.isArray(payload?.extraPaths) ? payload!.extraPaths : [];
      for (const raw of extras) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const p = path.normalize(raw.trim());
        await addImageFileToMap(p, map);
      }

      const items = [...map.entries()].map(([absolutePath, mtimeMs]) => ({
        absolutePath,
        mtimeMs,
      }));
      items.sort((a, b) => b.mtimeMs - a.mtimeMs);

      return { ok: true as const, items };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg, items: [] };
    }
  }
);
