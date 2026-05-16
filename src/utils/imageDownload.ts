/**
 * 会话/图库图片「另存」：Electron 优先主进程对话框；Web 壳为 Blob + 浏览器下载。
 * 存入系统相册可走移动端「长按大图 → 系统菜单」或使用分享（不在此按钮链路）。
 */
const INVALID_CHARS = /[\\/:"*?<>|\r\n\0]/g;

/**
 * 附件下载文件名：有这些扩展名时原样保留（仅做非法字符清理），避免被误判为图片而改成 .png。
 * 涵盖常见图片、Microsoft Office / OpenDocument、文本文档、数据与压缩包。
 */
const KNOWN_DOWNLOAD_EXT = new RegExp(
  '\\.(' +
    [
      // 图片（栅格 / 矢量 / RAW 容器）
      'png',
      'jpe?g',
      'jfif',
      'pjpeg',
      'gif',
      'webp',
      'bmp',
      'apng',
      'svgz?',
      'ico',
      'icns',
      'tiff?',
      'heic',
      'heif',
      'avif',
      'psd',
      'dng',
      // Microsoft Office
      'docx?',
      'dotx?',
      'docm',
      'dotm',
      'xlsx?',
      'xlsm',
      'xlsb',
      'xltx?',
      'xltm',
      'pptx?',
      'pptm',
      'potx?',
      'potm',
      'ppsx?',
      'ppsm',
      'vsdx?',
      'vsdm',
      'mdb',
      'accdb',
      // OpenDocument / Apple iWork（单文件导出）
      'odt',
      'ods',
      'odp',
      'odg',
      'odf',
      'pages',
      'numbers',
      'key',
      // 文档与标记 / 电子书
      'md',
      'markdown',
      'mdown',
      'mkd',
      'pdf',
      'txt',
      'text',
      'rtf',
      'epub',
      'mobi',
      'azw3',
      'tex',
      'adoc',
      'asciidoc',
      'org',
      'htm',
      'html',
      'xhtml',
      // 数据 / 序列化 / 日志
      'csv',
      'tsv',
      'json',
      'jsonl',
      'ndjson',
      'ya?ml',
      'toml',
      'xml',
      'properties',
      'log',
      'ini',
      'cfg',
      'conf',
      // 压缩与归档
      'zip',
      'rar',
      '7z',
      'tar',
      'gz',
      'tgz',
      'bz2',
      'xz',
      'cab',
    ].join('|') +
    ')$',
  'i',
);

/** 文件名安全处理；无合法扩展名时按 MIME 补 .png /.jpg 等 */
export function sanitizeImageDownloadFileName(raw: string, mimeHint?: string): string {
  let name = String(raw || '').trim() || 'image';
  name = name.replace(INVALID_CHARS, '_').slice(0, 180) || 'image';
  if (KNOWN_DOWNLOAD_EXT.test(name)) return name;

  const m = (mimeHint || '').toLowerCase();
  const base = name.replace(/\.[^./\\]+$/, '') || 'image';
  const ext =
    m.includes('jpeg') || m.includes('jpg') ? '.jpg'
    : m.includes('gif') ? '.gif'
    : m.includes('webp') ? '.webp'
    : '.png';

  return `${base}${ext}`;
}

/** 本机另存为 IPC 已明确失败（勿再 fetch，避免系统/浏览器多一道提示） */
export class DownloadLocalFileError extends Error {
  readonly code: 'source_missing' | 'path_empty';

  constructor(code: 'source_missing' | 'path_empty') {
    super(code);
    this.name = 'DownloadLocalFileError';
    this.code = code;
  }
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
  /** 已拷贝成功 | 用户在对话框取消（勿再 fallback / 报错） | 未走 Electron / 可复制失败仍可尝试 fetch */
  const tryElectronSave = async (): Promise<'saved' | 'canceled' | 'continue'> => {
    const path = (opts.sourceLocalPath ?? '').trim();
    if (!path) return 'continue';
    const e = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof e?.saveLocalFileCopy !== 'function') return 'continue';
    const r = await e.saveLocalFileCopy({
      sourcePath: path,
      defaultFileName: sanitizeImageDownloadFileName(opts.defaultFileName, 'image/png'),
    });
    if (r.ok) return 'saved';
    if (r.canceled === true) return 'canceled';
    if (r.error === '源文件不存在') throw new DownloadLocalFileError('source_missing');
    if (r.error === '路径为空') throw new DownloadLocalFileError('path_empty');
    return 'continue';
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

  const ipcOutcome = await tryElectronSave();
  if (ipcOutcome === 'saved' || ipcOutcome === 'canceled') return;

  const primary = opts.src.trim();
  const fb = (opts.fallbackSrc ?? '').trim();

  if (await tryFetchAndDownload(primary)) return;
  if (fb && fb !== primary && (await tryFetchAndDownload(fb))) return;

  throw new Error('unable to save image');
}
