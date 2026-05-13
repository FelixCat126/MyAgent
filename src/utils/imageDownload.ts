/**
 * 会话/图库图片「另存」：Electron 优先主进程对话框；Web 壳为 Blob + 浏览器下载。
 * 存入系统相册可走移动端「长按大图 → 系统菜单」或使用分享（不在此按钮链路）。
 */
const INVALID_CHARS = /[\\/:"*?<>|\r\n\0]/g;

/** 文件名安全处理；无合法扩展名时按 MIME 补 .png /.jpg 等 */
export function sanitizeImageDownloadFileName(raw: string, mimeHint?: string): string {
  let name = String(raw || '').trim() || 'image';
  name = name.replace(INVALID_CHARS, '_').slice(0, 180) || 'image';
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return name;

  const m = (mimeHint || '').toLowerCase();
  const base = name.replace(/\.[^./\\]+$/, '') || 'image';
  const ext =
    m.includes('jpeg') || m.includes('jpg') ? '.jpg'
    : m.includes('gif') ? '.gif'
    : m.includes('webp') ? '.webp'
    : '.png';

  return `${base}${ext}`;
}

function triggerAnchorDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2500);
}

/** Electron「另存为」；其余走 fetch blob 后下载链接 */
export async function downloadDisplayImage(opts: {
  src: string;
  defaultFileName: string;
  sourceLocalPath?: string;
  fallbackSrc?: string;
}): Promise<void> {
  const tryElectronSave = async (): Promise<boolean> => {
    const path = (opts.sourceLocalPath ?? '').trim();
    if (!path) return false;
    const e = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof e?.saveLocalFileCopy !== 'function') return false;
    const r = await e.saveLocalFileCopy({
      sourcePath: path,
      defaultFileName: sanitizeImageDownloadFileName(opts.defaultFileName, 'image/png'),
    });
    return Boolean(r?.ok);
  };

  const tryFetchAndDownload = async (url: string): Promise<boolean> => {
    const u = url.trim();
    if (!u) return false;
    try {
      const res = await fetch(u, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (!res.ok) return false;
      const blob = await res.blob();
      triggerAnchorDownload(blob, sanitizeImageDownloadFileName(opts.defaultFileName, blob.type || ''));
      return true;
    } catch {
      return false;
    }
  };

  if (await tryElectronSave()) return;

  const primary = opts.src.trim();
  const fb = (opts.fallbackSrc ?? '').trim();

  if (await tryFetchAndDownload(primary)) return;
  if (fb && fb !== primary && (await tryFetchAndDownload(fb))) return;

  throw new Error('unable to save image');
}
