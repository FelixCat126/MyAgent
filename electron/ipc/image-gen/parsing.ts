/**
 * 图像生成响应解析辅助函数。
 * 与 image-gen.ts 解耦后可独立测试。
 */

export function looksLikeBinaryImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return true;
  return false;
}

export function base64FieldToImageBuffer(raw: string | undefined): Buffer | null {
  if (typeof raw !== 'string' || raw.length < 32) return null;
  let s = raw.trim().replace(/\s/g, '');
  const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length < 64) return null;
    if (
      (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
      (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
      (buf.length >= 12 &&
        buf.slice(0, 4).toString() === 'RIFF' &&
        buf.slice(8, 12).toString() === 'WEBP')
    ) {
      return buf;
    }
    return buf.length >= 320 ? buf : null;
  } catch {
    return null;
  }
}

export function stripUtf8Bom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}
