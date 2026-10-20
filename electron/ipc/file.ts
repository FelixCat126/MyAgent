import { ipcMain, app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { isSensitiveReadPath } from '../utils/documentText';

/** 使用 userData，避免放在 /var/.../T 下被系统清掉导致会话里图片 404 */
export function getUploadDir(): string {
  return path.join(app.getPath('userData'), 'myagent-uploads');
}

const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

/** 落盘名：时间戳 + 随机段保证唯一；保留可读的原名（含中文 / emoji），去掉路径与非法字符并限长 */
export function uploadStorageName(originalName: string, timestamp = Date.now()): string {
  const base = path.basename(String(originalName || 'file'));
  const ext = path.extname(base).replace(/[^\w.]/g, '').slice(0, 16);
  const stem = Array.from(
    base
      .slice(0, base.length - path.extname(base).length)
      .replace(/[\\/:*?"<>|\u0000-\u001F%#]/g, '_')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 60)
    .join('')
    .replace(/[. ]+$/, '');
  return `${timestamp}-${randomUUID().slice(0, 8)}-${stem || 'file'}${ext}`;
}

/** 系统默认程序打开时会直接执行的类型 */
const EXECUTABLE_EXT =
  /\.(app|command|tool|sh|bash|zsh|csh|fish|exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|cpl|hta|reg|scpt|applescript|jar|lnk|url|webloc|workflow|action|terminal|pkg|mpkg|dmg|deb|rpm|appimage|desktop|run)$/i;

export function isExecutableOpenTarget(p: string): boolean {
  return EXECUTABLE_EXT.test(path.basename(p));
}

/** 远端网关等：与 upload-file IPC 相同落盘逻辑 */
export async function writeUploadBufferToUserData(payload: {
  name: string;
  buffer: Buffer;
  type: string;
  size: number;
}): Promise<{
  path: string;
  name: string;
  type: string;
  size: number;
  preview?: string;
}> {
  if (payload.buffer.length > UPLOAD_MAX_BYTES) {
    throw new Error(`附件过大（>${UPLOAD_MAX_BYTES / (1024 * 1024)}MB），请压缩或拆分后再上传。`);
  }
  await fs.mkdir(getUploadDir(), { recursive: true }).catch(() => undefined);
  const fileName = uploadStorageName(payload.name);
  const filePath = path.join(getUploadDir(), fileName);
  await fs.writeFile(filePath, payload.buffer);
  let preview: string | undefined;
  if (payload.type.startsWith('image/') && payload.size < 512000) {
    try {
      preview = `data:${payload.type};base64,${payload.buffer.toString('base64')}`;
    } catch {
      /* ignore */
    }
  }
  console.log(`文件已保存: ${filePath}, 预览已${preview ? '生成' : '跳过'} (size=${payload.size}, type=${payload.type})`);
  return {
    path: filePath,
    name: payload.name,
    type: payload.type,
    size: payload.size,
    ...(preview ? { preview } : {}),
  };
}

// 处理文件上传
ipcMain.handle('upload-file', async (_event, fileData: {
  name: string;
  buffer: number[];
  type: string;
  size: number;
}) => {
  try {
    const buffer = Buffer.from(fileData.buffer);
    return await writeUploadBufferToUserData({
      name: fileData.name,
      buffer,
      type: fileData.type,
      size: fileData.size,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('文件上传失败:', msg);
    throw new Error(msg);
  }
});

// 清理本应用上传目录（含持久化附件；仅应在用户明确「清缓存」等场景调用）
ipcMain.handle('cleanup-uploads', async () => {
  try {
    await fs.rm(getUploadDir(), { recursive: true, force: true });
    console.log('上传目录已清理');
  } catch (error: unknown) {
    console.error('清理上传目录失败:', error instanceof Error ? error.message : String(error));
  }
});

/** 使用系统默认应用打开本地产物；界面中的“打开”不再等同于再次另存。 */
ipcMain.handle('open-local-file', async (_event, arg: { path: string }) => {
  const raw = String(arg?.path || '').trim();
  if (!raw) return { ok: false as const, error: '路径为空' };
  const resolved = path.resolve(raw);
  if (isExecutableOpenTarget(resolved)) {
    return { ok: false as const, error: '出于安全考虑，不直接打开可执行文件或脚本' };
  }
  if (isSensitiveReadPath(resolved)) {
    return { ok: false as const, error: '该路径属于系统或凭据目录，已拒绝打开' };
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { ok: false as const, error: '不是可打开的文件' };
    if (isExecutableOpenTarget(await fs.realpath(resolved)) || ((stat.mode & 0o111) !== 0 && !path.extname(resolved))) {
      return { ok: false as const, error: '出于安全考虑，不直接打开可执行文件或脚本' };
    }
    const error = await shell.openPath(resolved);
    return error
      ? { ok: false as const, error }
      : { ok: true as const };
  } catch (error: unknown) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

console.log('✅ 文件处理 IPC 处理器已注册');
