import { app, ipcMain, type WebContents } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

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
          const res = await fetch(imageUrl, {
            method: 'GET',
            redirect: 'follow',
            signal: ctrl.signal,
            headers,
          });
          buf = Buffer.from(await res.arrayBuffer());
          if (!res.ok) {
            return { ok: false as const, error: `拉取图片 HTTP ${res.status}` };
          }
          contentType = contentType || res.headers.get('content-type') || '';
          ext = extFromUrl(imageUrl) || extFromContentType(contentType) || '.jpg';
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
