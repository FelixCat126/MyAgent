import { app, ipcMain, type WebContents } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import dns from 'dns/promises';
import net from 'net';

const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 5;

/** 回环 / 私有 / 链路本地 / 组播等地址：主进程代抓图片不得访问（防 SSRF 打本机服务与云元数据） */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('无效图片 URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host)) throw new Error('不允许访问本机地址');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('不允许访问内网或本机地址');
  return u;
}

async function readCappedBody(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > cap) throw new Error('图片超过 20MB');
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error('图片超过 20MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Agent 内嵌浏览器 IPC 桥：主进程仅转发到渲染进程的内嵌 webview 控制器。
 * 实际逻辑在 src/agent/browser/agentBrowserController.ts（由 ChatWindow 注册 window 桥）。
 */

function agentWebImagesDir(): string {
  return path.join(app.getPath('documents'), 'MyAgent', 'AgentWebImages');
}

function extFromContentType(ct: string | null): string {
  const t = String(ct || '').toLowerCase();
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  if (t.includes('bmp')) return '.bmp';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  return '.jpg';
}

function extFromUrl(imageUrl: string): string {
  try {
    const u = new URL(imageUrl);
    const ext = path.extname(u.pathname).toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch {
    /* ignore */
  }
  return '';
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'image/jpeg';
  }
}

async function invokeRendererBrowser<T>(wc: WebContents, method: string, arg?: unknown): Promise<T> {
  const payload = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return wc.executeJavaScript(
    `(async () => {
      const bridge = window.__MYAGENT_AGENT_BROWSER__;
      if (!bridge || typeof bridge.${method} !== 'function') {
        throw new Error('内嵌浏览器未初始化');
      }
      return await bridge.${method}(${payload});
    })()`
  ) as Promise<T>;
}

ipcMain.handle('agent-web-open', async (event, arg: { url?: string }) => {
  try {
    return await invokeRendererBrowser(event.sender, 'open', arg?.url ?? '');
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('agent-web-read', async (event, arg?: { maxChars?: number; selector?: string }) => {
  try {
    return await invokeRendererBrowser(event.sender, 'read', arg ?? null);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('agent-web-eval', async (event, arg: { js?: string }) => {
  try {
    return await invokeRendererBrowser(event.sender, 'eval', arg ?? null);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('agent-web-close', async (event) => {
  try {
    return await invokeRendererBrowser(event.sender, 'close', null);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

/** 将远程图片落盘为本机附件，供聊天气泡用 local-file: 展示（绕过防盗链需带 referer） */
ipcMain.handle(
  'agent-web-save-remote-image',
  async (
    _e,
    arg: {
      url?: string;
      referer?: string;
      fileName?: string;
      /** data:image/...;base64,... 或纯 base64（来自 webview 页内 fetch） */
      base64?: string;
      contentType?: string;
    }
  ) => {
    try {
      const dir = agentWebImagesDir();
      await fs.mkdir(dir, { recursive: true });

      let buf: Buffer;
      let ext = '.jpg';
      let contentType = String(arg?.contentType || '').trim();

      const b64raw = String(arg?.base64 || '').trim();
      if (b64raw.length > Math.ceil((MAX_REMOTE_IMAGE_BYTES * 4) / 3) + 256) {
        return { ok: false as const, error: '图片超过 20MB' };
      }
      if (b64raw) {
        const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(b64raw);
        if (dataUrl) {
          contentType = contentType || dataUrl[1]!;
          buf = Buffer.from(dataUrl[2]!, 'base64');
        } else {
          buf = Buffer.from(b64raw.replace(/\s+/g, ''), 'base64');
        }
        ext = extFromContentType(contentType) || '.jpg';
      } else {
        const imageUrl = String(arg?.url || '').trim();
        if (!/^https?:\/\//i.test(imageUrl)) {
          return { ok: false as const, error: '无效图片 URL' };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        try {
          const headers: Record<string, string> = {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          };
          const referer = String(arg?.referer || '').trim();
          if (referer) {
            headers.Referer = referer;
            try {
              headers.Origin = new URL(referer).origin;
            } catch {
              /* ignore */
            }
          }
          /** 手动跟随重定向：每一跳都校验目标不是本机 / 内网地址 */
          let target = await assertPublicHttpUrl(imageUrl);
          let res: Response;
          for (let hop = 0; ; hop++) {
            res = await fetch(target, {
              method: 'GET',
              redirect: 'manual',
              signal: ctrl.signal,
              headers,
            });
            const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
            if (!location) break;
            await res.body?.cancel().catch(() => undefined);
            if (hop >= MAX_IMAGE_REDIRECTS) return { ok: false as const, error: '图片重定向次数过多' };
            target = await assertPublicHttpUrl(new URL(location, target).href);
          }
          if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false as const, error: `拉取图片 HTTP ${res.status}` };
          }
          const resType = (res.headers.get('content-type') || '').toLowerCase();
          if (resType && !resType.startsWith('image/') && !resType.startsWith('application/octet-stream')) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false as const, error: '远程资源不是图片' };
          }
          buf = await readCappedBody(res, MAX_REMOTE_IMAGE_BYTES);
          contentType = contentType || res.headers.get('content-type') || '';
          ext = extFromUrl(target.href) || extFromContentType(contentType) || '.jpg';
        } finally {
          clearTimeout(timer);
        }
      }

      if (!buf?.length) return { ok: false as const, error: '图片内容为空' };

      const safeBase = String(arg?.fileName || 'web-image')
        .replace(/[\\/:"*?<>|\r\n\0]+/g, '_')
        .replace(/\.[a-z0-9]+$/i, '')
        .slice(0, 64);
      const fileName = `${safeBase || 'web-image'}-${randomUUID().slice(0, 8)}${ext}`;
      const outputPath = path.join(dir, fileName);
      await fs.writeFile(outputPath, buf);
      const mime = mimeFromExt(ext);
      const preview = `data:${mime};base64,${buf.toString('base64')}`;
      return {
        ok: true as const,
        path: outputPath,
        name: fileName,
        type: mime,
        size: buf.length,
        preview,
      };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }
);

console.log('✅ Agent 内嵌浏览器 IPC 已注册');
