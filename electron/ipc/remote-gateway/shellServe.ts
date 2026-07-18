import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

import { getUploadDir } from '../file';

function bundledDir(): string {
  /** 打入 dist-electron 主 chunk：与 remote-shell.html 同目录 */
  return path.dirname(fileURLToPath(import.meta.url));
}

/** 开发与打包路径差异下尽量找到 remote-shell.html */
function resolvedShellHtmlForDiag(): {
  chosenPath: string;
  shellExists: boolean;
  searchedPaths: string[];
} {
  const searchedPaths: string[] = [];
  const tryPush = (p: string): void => {
    if (p && !searchedPaths.includes(p)) searchedPaths.push(p);
  };
  try {
    tryPush(path.join(bundledDir(), 'remote-shell.html'));
  } catch {
    /* bundledDir 在极端打包形态下不可用 */
  }
  try {
    tryPush(path.join(app.getAppPath(), 'remote-shell.html'));
  } catch {
    /* ignore */
  }
  for (const p of searchedPaths) {
    if (fsSync.existsSync(p)) {
      return { chosenPath: p, shellExists: true, searchedPaths };
    }
  }
  const fallback =
    searchedPaths[0] ||
    ((): string => {
      try {
        return path.join(bundledDir(), 'remote-shell.html');
      } catch {
        return '';
      }
    })();
  return { chosenPath: fallback, shellExists: Boolean(fallback && fsSync.existsSync(fallback)), searchedPaths };
}

function shellHtmlPathForServe(): string {
  const r = resolvedShellHtmlForDiag();
  return r.chosenPath;
}

/** 加主屏幕用的 manifest / 图标；pathname 可为 /前缀/remote/...（反代子路径挂载）。 */
export function pickRemoteStandaloneAsset(pathNorm: string): 'manifest' | 'touchIcon' | null {
  if (/\/remote\/manifest\.webmanifest$/i.test(pathNorm)) return 'manifest';
  if (/\/remote\/apple-touch-icon\.png$/i.test(pathNorm)) return 'touchIcon';
  return null;
}

export function publicRemoteGatewayGet(method: string, pathNorm: string): boolean {
  if (method !== 'GET') return false;
  if (pathNorm === '/' || pathNorm === '/remote') return true;
  return pickRemoteStandaloneAsset(pathNorm) !== null;
}

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function resolvedUnderRoot(absFile: string, root: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(absFile);
  return f === r || f.startsWith(r + path.sep);
}

export function assertRemoteFileAccess(absPath: string): void {
  const target = path.resolve(absPath);
  /** 与图库/会话附件常见落点一致：令牌保护下允许读取，避免聊天里图片路径落在下载/桌面却因 403 整页图库空白 */
  const roots = [
    path.resolve(getUploadDir()),
    path.resolve(path.join(app.getPath('documents'), 'MyAgent')),
    path.resolve(app.getPath('desktop')),
    path.resolve(app.getPath('downloads')),
    path.resolve(app.getPath('pictures')),
  ];
  for (const r of roots) {
    if (resolvedUnderRoot(target, r)) return;
  }
  throw new Error('forbidden path');
}

export {
  bundledDir,
  resolvedShellHtmlForDiag,
  shellHtmlPathForServe,
  resolvedUnderRoot,
};