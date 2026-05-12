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

/** 远端网关与 IPC 共用：生成图目录 + 上传目录 + optional 会话中曾出现的路径 */
export async function listMediaLibraryImageItems(payload?: {
  extraPaths?: string[] | null;
}): Promise<
  | { ok: true; items: Array<{ absolutePath: string; mtimeMs: number }> }
  | { ok: false; error: string; items: [] }
> {
  try {
    const map = new Map<string, number>();

    await walkImageDir(generatedImagesDir(), map);
    await walkImageDir(uploadsDir(), map);

    const extras = Array.isArray(payload?.extraPaths) ? payload.extraPaths : [];
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

ipcMain.handle('list-media-library-images', async (_evt, payload?: { extraPaths?: string[] } | null) => {
  return listMediaLibraryImageItems({ extraPaths: payload?.extraPaths });
});

/** 主进程共用：仅能删生成图/上传缓存目录内的支持格式图片 */
export async function deleteMediaLibraryImageByAbsolutePath(rawPath: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const p = path.resolve(String(rawPath || '').trim());
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

ipcMain.handle(
  'delete-media-library-image',
  async (_evt, payload?: { absolutePath?: string } | null) => {
    return deleteMediaLibraryImageByAbsolutePath(String(payload?.absolutePath ?? ''));
  }
);
