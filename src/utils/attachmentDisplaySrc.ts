import { localFileProtocolUrl } from './localFileUrl';

/** 会话附件图片展示地址：支持 data: / http(s) / 本机路径 */
export function attachmentImageDisplaySrc(file: {
  path?: string;
  preview?: string;
}): string {
  const preview = String(file.preview || '').trim();
  if (preview.startsWith('data:') || /^https?:\/\//i.test(preview)) return preview;
  const p = String(file.path || '').trim();
  if (!p) return '';
  if (/^https?:\/\//i.test(p) || p.startsWith('data:')) return p;
  try {
    return localFileProtocolUrl(p);
  } catch {
    return '';
  }
}

export function isRemoteHttpUrl(value: string | undefined | null): boolean {
  return /^https?:\/\//i.test(String(value || '').trim());
}
