import path from 'path';
import type { IncomingMessage } from 'http';

export const BODY_JSON_CAP = 1_048_576;
export const BODY_UPLOAD_CAP = 92 * 1024 * 1024;

export function collectBody(raw: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    raw.on('data', (c: Buffer) => {
      len += c.length;
      if (len > cap) {
        reject(new Error('payload too large'));
        raw.destroy();
        return;
      }
      chunks.push(c);
    });
    raw.on('end', () => resolve(Buffer.concat(chunks)));
    raw.on('error', reject);
  });
}

/** 轻量 multipart 解析：表单字段名为 `f`，与 remote-shell.html 一致 */
export function parseMultipartFiles(
  body: Buffer,
  contentType: string | undefined
): Promise<Array<{ buffer: Buffer; name: string; type: string; size: number }>> {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) {
    throw new Error('Expected multipart/form-data');
  }
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const bRaw = ((m?.[1] ?? m?.[2]) ?? '').trim();
  if (!bRaw) throw new Error('Missing multipart boundary');

  const files: Array<{ buffer: Buffer; name: string; type: string; size: number }> = [];

  let pos = body.indexOf(Buffer.from('--' + bRaw + '\r\n'));
  if (pos < 0) return Promise.resolve(files);
  pos += `--${bRaw}\r\n`.length;

  const endMark = Buffer.from(`\r\n--${bRaw}--`);

  while (pos < body.length) {
    if (body.subarray(pos, Math.min(body.length, pos + endMark.length)).equals(endMark)) break;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd < 0) break;
    const headerStr = body.subarray(pos, headerEnd).toString('latin1');

    pos = headerEnd + 4;

    const nextSep = body.indexOf(Buffer.from('\r\n--' + bRaw), pos);
    if (nextSep < 0) {
      const fallback = body.indexOf(endMark, pos);
      const dataEnd = fallback >= 0 ? fallback : body.length;
      const data = body.subarray(pos, dataEnd);
      tryParsePart(headerStr, data, files);
      break;
    }
    const data = body.subarray(pos, nextSep);
    tryParsePart(headerStr, data, files);
    pos = nextSep + `\r\n--${bRaw}`.length;
    if (body.subarray(pos, pos + 2).equals(Buffer.from('\r\n'))) pos += 2;
  }

  return Promise.resolve(files);
}

function tryParsePart(
  headerStr: string,
  data: Buffer,
  files: Array<{ buffer: Buffer; name: string; type: string; size: number }>
): void {
  const disposition = /^Content-Disposition:\s*(.+)$/im.exec(headerStr);
  if (!disposition?.[1]) return;
  const disp = disposition[1];
  const nameM = /\bname="([^"]+)"/i.exec(disp);
  const fnameM = /\bfilename="([^"]*)"/i.exec(disp);
  /** remote-shell.html 仅用 `name="f"`，且须带文件名 */
  if (!nameM || nameM[1] !== 'f' || fnameM?.[1] === undefined || fnameM[1] === '') return;

  const typeM = /^Content-Type:\s*(.+)$/im.exec(headerStr);
  const mime = typeM?.[1]?.trim() ? typeM[1].trim().split(';')[0].trim() : 'application/octet-stream';

  const fileNameRaw = fnameM[1];
  /** 段边界已通过 subarray(..., nextSep) 截掉，末尾不得再砍 CRLF，否则会截断本应合法以 CRLF 结尾的二进制附件 */

  files.push({
    buffer: data,
    name: path.basename(fileNameRaw) || fileNameRaw || `upload-${Date.now()}`,
    type: mime,
    size: data.length,
  });
}

/** 反代或子路径挂载后 pathname 形如 /xxx/remote/api/... 或 /pref/api/session/active */
export function normalizeRemoteRequestPathname(raw: string): string {
  let pathNorm = (raw || '/').replace(/\/+/g, '/');
  if (pathNorm.length > 1 && pathNorm.endsWith('/')) pathNorm = pathNorm.slice(0, -1);
  const mr = '/remote/api/';
  const ir = pathNorm.lastIndexOf(mr);
  if (ir > 0) pathNorm = pathNorm.slice(ir);
  if (!pathNorm.startsWith('/remote/api/')) {
    const ia = pathNorm.lastIndexOf('/api/');
    if (ia >= 0) pathNorm = `/remote/api/${pathNorm.slice(ia + '/api/'.length)}`;
  }
  return pathNorm;
}