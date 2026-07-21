import http from 'http';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import type { IncomingMessage } from 'http';
import type { BrowserWindow } from 'electron';

import {
  deleteMediaLibraryImageByAbsolutePath,
  listMediaLibraryImageItems,
} from '../media-library';
import { writeUploadBufferToUserData } from '../file';
import type { RemoteGatewayFileConfig } from './config';
import { REMOTE_MODEL_IDS_FALLBACK, coerceRemoteModelSnap, deriveModelsFromPersistDisk } from './config';
import { BODY_JSON_CAP, BODY_UPLOAD_CAP, collectBody, normalizeRemoteRequestPathname, parseMultipartFiles } from './multipart';
import { authorize } from './auth';
import {
  assertRemoteFileAccess,
  mimeForPath,
  pickRemoteStandaloneAsset,
  publicRemoteGatewayGet,
  resolvedShellHtmlForDiag,
  shellHtmlPathForServe,
} from './shellServe';

let getMainWindowImpl: () => BrowserWindow | null = () => null;
let activeConfig: RemoteGatewayFileConfig | null = null;
let server: http.Server | null = null;
let lastListenError: string | null = null;

export function setMainWindowGetter(getter: () => BrowserWindow | null): void {
  getMainWindowImpl = getter;
}

export function setActiveConfig(cfg: RemoteGatewayFileConfig | null): void {
  activeConfig = cfg;
}

export function setLastListenError(msg: string | null): void {
  lastListenError = msg;
}

export function setServer(s: http.Server | null): void {
  server = s;
}

export function getServer(): http.Server | null {
  return server;
}

export function getActiveConfig(): RemoteGatewayFileConfig | null {
  return activeConfig;
}

export function getLastListenError(): string | null {
  return lastListenError;
}

function touchCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length');
}

function sendJson(res: http.ServerResponse, code: number, body: Record<string, unknown>): void {
  touchCors(res);
  const data = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

async function invokeBridge(runner: string): Promise<unknown> {
  const win = getMainWindowImpl();
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (!wc || wc.isDestroyed()) {
    throw new Error('REMOTE_NO_WINDOW');
  }
  /** 脚本内避免重复 JSON 插值逃逸问题 */
  return await wc.executeJavaScript(`(async () => {
    const bridge = typeof window.__MYAGENT_REMOTE_BRIDGE__ !== 'undefined' ? window.__MYAGENT_REMOTE_BRIDGE__ : null;
    if (!bridge) throw new Error('REMOTE_BRIDGE_NOT_READY');
    return await (${runner})();
  })()`);
}

/** 把 payload 安全内联进桥接脚本：双层 JSON 转义只此一处，避免少一层即成注入 */
function inlineBridgeArg(value: unknown): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

/** JSON body 读取样板：collectBody + parse；返回 null 时已回 400 */
async function readJsonBody(
  req: IncomingMessage,
  res: http.ServerResponse
): Promise<Record<string, unknown> | null> {
  const raw = await collectBody(req, BODY_JSON_CAP);
  try {
    return JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return null;
  }
}

/** 远端入参 id 归一化：string→trim，number→String，其余为空 */
function coerceId(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

async function handleRequest(req: IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://0.0.0.0');
    let pathNorm = normalizeRemoteRequestPathname(url.pathname || '/');
    const method = (req.method || 'GET').toUpperCase();

    /** 反代常见去掉 `/remote` 前缀，统一到内部路由 `/remote/api/...` */
    if (!pathNorm.startsWith('/remote/api/')) {
      /** 少见：前缀被双重去掉后只剩 `/session/active`、/state等 */
      const bareToRemote: Record<string, string> = {
        '/meta': '/remote/api/meta',
        '/models': '/remote/api/models',
        '/state': '/remote/api/state',
        '/session': '/remote/api/session',
        '/session/active': '/remote/api/session/active',
        '/chat': '/remote/api/chat',
        '/upload': '/remote/api/upload',
        '/messages/remove': '/remote/api/messages/remove',
        '/messages/patch': '/remote/api/messages/patch',
        '/messages/resubmit': '/remote/api/messages/resubmit',
        '/media-library': '/remote/api/media-library',
        '/media-library/delete': '/remote/api/media-library/delete',
        '/model/active': '/remote/api/model/active',
        '/file': '/remote/api/file',
        /** 反代去掉 `/api/` 只剩 `/remote/...` 时的常见路径 */
        '/remote/session': '/remote/api/session',
        '/remote/session/active': '/remote/api/session/active',
        '/remote/state': '/remote/api/state',
        '/remote/chat': '/remote/api/chat',
        '/remote/upload': '/remote/api/upload',
        '/remote/models': '/remote/api/models',
        '/remote/model/active': '/remote/api/model/active',
        '/remote/messages/remove': '/remote/api/messages/remove',
        '/remote/messages/patch': '/remote/api/messages/patch',
        '/remote/messages/resubmit': '/remote/api/messages/resubmit',
        '/remote/media-library': '/remote/api/media-library',
        '/remote/media-library/delete': '/remote/api/media-library/delete',
        '/remote/meta': '/remote/api/meta',
      };
      const hit = bareToRemote[pathNorm];
      if (hit) pathNorm = hit;
    }

    /** 跨域 OPTIONS（含自定义 Authorization 的简单场景） */
    if (method === 'OPTIONS') {
      touchCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    /** 手机可访问：不占令牌；用于在不看电脑终端时判断是否「真的连上了本机网关」 */
    if (method === 'GET' && (pathNorm === '/diag' || pathNorm === '/remote/diag')) {
      const sh = resolvedShellHtmlForDiag();
      const payload = {
        myagentDiag: true,
        gatewayEnabled: Boolean(activeConfig?.enabled),
        tokenConfigured: Boolean(activeConfig?.token && String(activeConfig.token).trim()),
        port: activeConfig?.port ?? null,
        listening: Boolean(server?.listening),
        shellExists: sh.shellExists,
        shellChosenPath: sh.chosenPath,
        shellSearchList: sh.searchedPaths,
        listenLastError: lastListenError,
        /** 常见问题提示（非本地化，供手机用户直接阅读） */
        hints: ['令牌与桌面设置一致；勿将端口暴露到公网。'],
      };
      sendJson(res, 200, payload);
      return;
    }

    if (!activeConfig?.enabled || !activeConfig.token) {
      const wantShell = method === 'GET' && (pathNorm === '/' || pathNorm === '/remote');
      if (wantShell) {
        const tipPage = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/>
<title>远端网关未开启</title></head><body style="font-family:system-ui;padding:16px;background:#111;color:#e6e9ef;line-height:1.5;">
<p style="margin:0 0 12px;font-size:16px">电脑上 MyAgent 的<strong>远端网页网关</strong>尚未开启，或令牌未初始化。</p>
<p style="font-size:14px;color:#8892a6">请先在本机桌面应用：<strong>设置 → 应用与隐私 → 远端网页访问</strong>打开开关。</p>
<p style="margin-top:20px;font-size:14px"><a style="color:#5b9cf6" href="/diag">点此打开自检信息（不占令牌）</a></p></body></html>`;
        res.statusCode = 200;
        touchCors(res);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(tipPage);
        return;
      }
      sendJson(res, 503, {
        error: 'Remote gateway disabled',
        tip: '在电脑 MyAgent「设置→应用与隐私」中开启远端网页网关。',
        diagPath: `/diag （手机浏览器可直接打开自检 JSON）`,
      });
      return;
    }

    /** 远端壳与 PWA manifest/图标可不带头令牌（令牌仍在页面内用于 API）；与 pathNorm === /remote 同属公开 GET */
    const publicShellGet = publicRemoteGatewayGet(method, pathNorm);

    const token = activeConfig.token;
    if (!publicShellGet && !authorize(req, token)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const standaloneAsset = pickRemoteStandaloneAsset(pathNorm);
    if (method === 'GET' && standaloneAsset) {
      const htmlPath = shellHtmlPathForServe();
      const shelldir = path.dirname(htmlPath);
      const fname =
        standaloneAsset === 'manifest' ? 'remote-manifest.webmanifest' : 'remote-apple-touch-icon.png';
      const fp = path.join(shelldir, fname);
      if (!fsSync.existsSync(fp)) {
        sendJson(res, 404, { error: `Missing remote PWA asset (${fp})`, kind: standaloneAsset });
        return;
      }
      const buf = await fs.readFile(fp);
      res.statusCode = 200;
      touchCors(res);
      res.setHeader('Content-Type', mimeForPath(fp));
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(buf);
      return;
    }

    /** 静态远端页 */
    if (method === 'GET' && (pathNorm === '/' || pathNorm === '/remote')) {
      const htmlPath = shellHtmlPathForServe();
      if (!fsSync.existsSync(htmlPath)) {
        const sh = resolvedShellHtmlForDiag();
        sendJson(res, 500, {
          error: `Missing remote-shell (${htmlPath})`,
          searched: sh.searchedPaths,
        });
        return;
      }
      const buf = await fs.readFile(htmlPath);
      res.statusCode = 200;
      touchCors(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      return;
    }

    /** API（method 已于上方求得） */

    if (method === 'GET' && pathNorm === '/remote/api/meta') {
      const modelNameRaw = await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        return bridge && bridge.getActiveModelLabel ? await bridge.getActiveModelLabel() : '';
      }`);
      const modelName =
        typeof modelNameRaw === 'string' ? modelNameRaw : String(modelNameRaw ?? '');
      sendJson(res, 200, { modelName: modelName || '' });
      return;
    }

    if (method === 'GET' && pathNorm === '/remote/api/models') {
      let bridged = { models: [] as Array<{ id: string; name: string }>, activeModelId: null as string | null };
      try {
        const snap = await invokeBridge(`async () => {
        const b = window.__MYAGENT_REMOTE_BRIDGE__;
        return b && b.getModelsSnapshot ? await b.getModelsSnapshot() : { models: [], activeModelId: null };
      }`);
        const o = snap as { models?: unknown; activeModelId?: unknown };
        bridged = coerceRemoteModelSnap(o.models, o.activeModelId);
      } catch {
        bridged = { models: [], activeModelId: null };
      }
      let models = bridged.models;
      let activeModelId = bridged.activeModelId;
      if (!models.length) {
        const fromDisk = deriveModelsFromPersistDisk();
        if (fromDisk) {
          models = fromDisk.models;
          activeModelId = fromDisk.activeModelId ?? models[0]?.id ?? null;
        }
      }
      if (!models.length) {
        models = [...REMOTE_MODEL_IDS_FALLBACK];
        activeModelId = models[0]?.id ?? null;
      } else if (activeModelId && !models.some((m) => m.id === activeModelId)) {
        activeModelId = models[0]?.id ?? null;
      } else if (!activeModelId) {
        activeModelId = models[0]?.id ?? null;
      }
      sendJson(res, 200, { models, activeModelId });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/model/active') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const modelId = coerceId(body.modelId);
      if (!modelId) {
        sendJson(res, 400, { error: 'modelId required' });
        return;
      }
      await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        const id = ${inlineBridgeArg(modelId)};
        await bridge.setActiveModelId(id);
      }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathNorm === '/remote/api/media-library') {
      let extras: string[] = [];
      try {
        const extrasRaw = await invokeBridge(`async () => {
        const b = window.__MYAGENT_REMOTE_BRIDGE__;
        return b && b.collectChatImageAttachmentPathsForMediaLibrary
          ? await b.collectChatImageAttachmentPathsForMediaLibrary()
          : [];
      }`);
        extras = Array.isArray(extrasRaw)
          ? extrasRaw.filter((x): x is string => typeof x === 'string')
          : [];
      } catch {
        extras = [];
      }
      const scanned = await listMediaLibraryImageItems({ extraPaths: extras });
      if (!scanned.ok) {
        sendJson(res, 500, { error: scanned.error || 'scan failed', items: [] });
        return;
      }
      sendJson(res, 200, {
        items: scanned.items.map((x) => ({ path: x.absolutePath, mtimeMs: x.mtimeMs })),
      });
      return;
    }

    if (method === 'GET' && pathNorm === '/remote/api/state') {
      const snap = await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        return bridge && bridge.getSnapshot ? await bridge.getSnapshot() : {};
      }`);
      sendJson(res, 200, snap as Record<string, unknown>);
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/messages/remove') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const sessionId = coerceId(body.sessionId);
      const idsRaw = body.messageIds;
      const messageIds = Array.isArray(idsRaw)
        ? idsRaw
            .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : ''))
            .filter((x) => x.length > 0)
        : [];
      if (!sessionId || messageIds.length === 0) {
        sendJson(res, 400, { error: 'sessionId and messageIds required' });
        return;
      }
      await invokeBridge(`async () => {
          const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
          const payload = ${inlineBridgeArg({ sessionId: sessionId as string, messageIds })};
          await bridge.removeChatMessagesRemote(payload);
        }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/messages/patch') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const sessionId = coerceId(body.sessionId);
      const messageId = coerceId(body.messageId);
      const content = typeof body.content === 'string' ? body.content : '';
      if (!sessionId || !messageId) {
        sendJson(res, 400, { error: 'sessionId and messageId required' });
        return;
      }
      await invokeBridge(`async () => {
          const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
          const payload = ${inlineBridgeArg({ sessionId, messageId, content })};
          await bridge.patchChatMessageRemote(payload);
        }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/messages/resubmit') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const sessionId = coerceId(body.sessionId);
      const messageId = coerceId(body.messageId);
      const content = typeof body.content === 'string' ? body.content : '';
      if (!sessionId || !messageId) {
        sendJson(res, 400, { error: 'sessionId and messageId required' });
        return;
      }
      await invokeBridge(`async () => {
          const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
          const payload = ${inlineBridgeArg({ sessionId, messageId, content })};
          await bridge.resubmitEditedUserMessageRemote(payload);
        }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/media-library/delete') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const p =
        typeof body.path === 'string'
          ? body.path.trim()
          : typeof body.absolutePath === 'string'
            ? body.absolutePath.trim()
            : '';
      if (!p) {
        sendJson(res, 400, { error: 'path required' });
        return;
      }
      const rm = await deleteMediaLibraryImageByAbsolutePath(p);
      if (!rm.ok) {
        sendJson(res, 400, { error: rm.error });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/session/active') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const sessionId = coerceId(body.sessionId);
      if (!sessionId) {
        sendJson(res, 400, { error: 'sessionId required' });
        return;
      }
      await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        const sid = ${inlineBridgeArg(sessionId)};
        await bridge.switchToSession(sid);
      }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/session') {
      const wrap = await invokeBridge(`async () => {
          const b = window.__MYAGENT_REMOTE_BRIDGE__;
          return await b.createChatSession();
        }`);
      const wid = wrap as { sessionId?: string };
      const id = typeof wid.sessionId === 'string' ? wid.sessionId : String(wid.sessionId ?? '');
      sendJson(res, 200, { sessionId: id });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/chat') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const sessionId = coerceId(body.sessionId);
      const content = typeof body.content === 'string' ? body.content : '';
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      /** 异步执行：即刻返回；桌面端沿用流式 SSE，远端通过轮询 /state 拉取增量内容 */
      await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        const payload = ${inlineBridgeArg({ sessionId, content, attachments })};
        void bridge.sendChat(payload).catch(function (err) {
          console.warn('[remote-gateway] sendChat failed', err);
        });
      }`);
      sendJson(res, 200, { ok: true, streaming: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/upload') {
      const rawBody = await collectBody(req, BODY_UPLOAD_CAP);
      const parts = await parseMultipartFiles(rawBody, req.headers['content-type']);
      const uploaded: Record<string, unknown>[] = [];
      for (const p of parts) {
        const meta = await writeUploadBufferToUserData({
          name: p.name,
          buffer: p.buffer,
          type: p.type,
          size: p.size,
        });
        uploaded.push({
          path: meta.path,
          name: meta.name,
          type: meta.type,
          size: meta.size,
          ...(meta.preview ? { preview: meta.preview } : {}),
        });
      }
      sendJson(res, 200, { files: uploaded });
      return;
    }

    if (method === 'GET' && pathNorm === '/remote/api/file') {
      const encoded = url.searchParams.get('p');
      if (!encoded) {
        sendJson(res, 400, { error: 'Missing p' });
        return;
      }
      let filePath: string;
      try {
        filePath = decodeURIComponent(encoded);
      } catch {
        sendJson(res, 400, { error: 'Bad path encoding' });
        return;
      }
      try {
        assertRemoteFileAccess(filePath);
      } catch {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!fsSync.existsSync(filePath)) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      const buf = await fs.readFile(filePath);
      const mime = mimeForPath(filePath);
      touchCors(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      const baseName = path.basename(filePath);
      if (!mime.startsWith('image/')) {
        const star = encodeURIComponent(baseName).replace(/[!'()*]/g, (c) =>
          `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
        );
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${star}`);
      }
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/REMOTE_BRIDGE_NOT_READY/i.test(msg) || msg === 'REMOTE_NO_WINDOW') {
      sendJson(res, 503, { error: 'Desktop UI not ready' });
      return;
    }
    console.warn('[remote-gateway]', msg);
    /** 对外不回传内部错误明细（可能含文件路径等），仅写本地日志 */
    sendJson(res, 500, { error: 'internal' });
  }
}

function stripHttpListen(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) return resolve(undefined);
    const s = server;
    server = null;
    s.close((e) => (e ? reject(e) : resolve(undefined)));
  });
}

export async function applyRemoteGatewayListening(cfg: RemoteGatewayFileConfig): Promise<void> {
  await stripHttpListen();
  activeConfig = cfg;

  if (!cfg.enabled || !cfg.token) {
    console.log('[RemoteGateway] off');
    lastListenError = null;
    return;
  }

  let inst: http.Server | null = null;
  try {
    inst = http.createServer((req, res) => {
      void handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const s = inst;
      if (!s) return reject(new Error('no server'));
      s.once('error', reject);
      s.listen(cfg.port, '0.0.0.0', () => {
        s.off('error', reject);
        server = inst;
        lastListenError = null;
        console.log(`[RemoteGateway] listening 0.0.0.0:${cfg.port}`);
        resolve(undefined);
      });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastListenError = msg;
    console.error('[RemoteGateway] listen failed:', msg);
    if (inst) {
      try {
        inst.close();
      } catch {
        /* ignore */
      }
    }
    server = null;
    throw e;
  }
}

export { handleRequest };