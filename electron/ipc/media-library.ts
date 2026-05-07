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

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
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

ipcMain.handle(
  'delete-media-library-image',
  async (_evt, payload?: { absolutePath?: string } | null) => {
    try {
      const p = path.resolve(String(payload?.absolutePath || '').trim());
      if (!p) return { ok: false as const, error: '路径为空' };
      if (!isInsideDir(p, generatedImagesDir()) && !isInsideDir(p, uploadsDir())) {
        return { ok: false as const, error: '只能删除 MyAgent 生成图或上传缓存目录中的图片' };
      }
      const ext = path.extname(p).toLowerCase();
      if (!IMAGE_EXT.has(ext)) return { ok: false as const, error: '不是支持的图片文件' };
      await fs.rm(p, { force: true });
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  }
);
