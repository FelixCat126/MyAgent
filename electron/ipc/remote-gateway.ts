import http from 'http';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, BrowserWindow } from 'electron';
import type { IncomingMessage } from 'http';

import { getUploadDir, writeUploadBufferToUserData } from './file';
import {
  deleteMediaLibraryImageByAbsolutePath,
  listMediaLibraryImageItems,
} from './media-library';
import { readPersistParsedSync } from './persist';

const CONFIG_FILE = 'remote-gateway.json';
const DEFAULT_PORT = 9742;
const BODY_JSON_CAP = 1_048_576;
const BODY_UPLOAD_CAP = 92 * 1024 * 1024;

/** 与桌面 modelStore 默认项 id/name 对齐，桥接不可用或瞬时返回空时用 */
const REMOTE_MODEL_IDS_FALLBACK: Array<{ id: string; name: string }> = [
  { id: 'ollama-qwen3-vl-8b', name: 'Qwen3-VL 8B (本地)' },
  { id: 'ollama-qwen3-vl-2b', name: 'Qwen3-VL 2B (本地)' },
  { id: 'ollama-gemma4-26b', name: 'Gemma4 26B (本地)' },
];

function coerceRemoteModelSnap(
  models: unknown,
  active: unknown
): { models: Array<{ id: string; name: string }>; activeModelId: string | null } {
  const outModels: Array<{ id: string; name: string }> = [];
  if (Array.isArray(models)) {
    for (const m of models) {
      const rec = m as { id?: unknown; name?: unknown };
      const id = typeof rec.id === 'string' ? rec.id.trim() : rec.id != null ? String(rec.id).trim() : '';
      const name =
        typeof rec.name === 'string' ? rec.name.trim() : rec.name != null ? String(rec.name).trim() : '';
      if (id && name) outModels.push({ id, name });
      else if (id) outModels.push({ id, name: id });
    }
  }
  const activeModelId =
    typeof active === 'string' && active.trim()
      ? active.trim()
      : active == null
        ? null
        : String(active).trim() || null;
  return { models: outModels, activeModelId };
}

function deriveModelsFromPersistDisk(): {
  models: Array<{ id: string; name: string }>;
  activeModelId: string | null;
} | null {
  try {
    const raw = readPersistParsedSync('model-storage');
    if (!raw || typeof raw !== 'object') return null;
    const st = (raw as { state?: unknown }).state;
    if (!st || typeof st !== 'object') return null;
    const { models: mList, activeModelId } = coerceRemoteModelSnap(
      (st as { models?: unknown }).models,
      (st as { activeModelId?: unknown }).activeModelId
    );
    if (!mList.length) return null;
    let activeOk = activeModelId;
    if (!activeOk || !mList.some((m) => m.id === activeOk)) activeOk = mList[0].id;
    return { models: mList, activeModelId: activeOk ?? null };
  } catch {
    return null;
  }
}

export interface RemoteGatewayFileConfig {
  enabled: boolean;
  port: number;
  token: string;
}

let getMainWindowImpl: () => BrowserWindow | null = () => null;
let activeConfig: RemoteGatewayFileConfig | null = null;
let server: http.Server | null = null;
let lastListenError: string | null = null;

export function attachRemoteGatewayMainWindow(getter: () => BrowserWindow | null): void {
  getMainWindowImpl = getter;
}

function configFilePath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function normalizeConfig(parsed: Record<string, unknown>): RemoteGatewayFileConfig {
  const enabled = Boolean(parsed.enabled);
  const portRaw = Number(parsed.port);
  const port =
    Number.isFinite(portRaw) && portRaw >= 1024 && portRaw <= 65535 ? Math.floor(portRaw) : DEFAULT_PORT;
  const tokenRaw = parsed.token != null ? String(parsed.token).trim() : '';
  const token = tokenRaw.length > 0 ? tokenRaw : randomToken();
  return { enabled, port, token };
}

async function loadOrCreateConfig(): Promise<RemoteGatewayFileConfig> {
  try {
    const txt = await fs.readFile(configFilePath(), 'utf-8');
    const parsed = JSON.parse(txt) as Record<string, unknown>;
    const n = normalizeConfig(parsed);
    if (!parsed.token || !String(parsed.token).trim()) {
      await persistConfig(n);
    }
    return n;
  } catch {
    const cfg: RemoteGatewayFileConfig = { enabled: false, port: DEFAULT_PORT, token: randomToken() };
    await persistConfig(cfg);
    return cfg;
  }
}

async function persistConfig(cfg: RemoteGatewayFileConfig): Promise<void> {
  await fs.mkdir(path.dirname(configFilePath()), { recursive: true });
  await fs.writeFile(configFilePath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
}

export function mergeRemoteGatewayPatch(
  current: RemoteGatewayFileConfig,
  patch: Partial<Pick<RemoteGatewayFileConfig, 'enabled' | 'port' | 'token'>> & { regenerateToken?: boolean }
): RemoteGatewayFileConfig {
  let next = { ...current };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.regenerateToken) next.token = randomToken();
  if (patch.port !== undefined && patch.port !== null) {
    const p = Number(patch.port);
    if (!Number.isFinite(p) || p < 1024 || p > 65535) {
      throw new Error('remote-gateway: invalid port (1024-65535)');
    }
    next.port = Math.floor(p);
  }
  if (patch.token !== undefined && patch.token !== null && !patch.regenerateToken) {
    const tok = String(patch.token).trim();
    if (!tok.length) throw new Error('remote-gateway: token empty');
    next.token = tok;
  }
  return next;
}

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
function pickRemoteStandaloneAsset(pathNorm: string): 'manifest' | 'touchIcon' | null {
  if (/\/remote\/manifest\.webmanifest$/i.test(pathNorm)) return 'manifest';
  if (/\/remote\/apple-touch-icon\.png$/i.test(pathNorm)) return 'touchIcon';
  return null;
}

function publicRemoteGatewayGet(method: string, pathNorm: string): boolean {
  if (method !== 'GET') return false;
  if (pathNorm === '/' || pathNorm === '/remote') return true;
  return pickRemoteStandaloneAsset(pathNorm) !== null;
}

function mimeForPath(filePath: string): string {
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

function collectBody(raw: IncomingMessage, cap: number): Promise<Buffer> {
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
function parseMultipartFiles(
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
function normalizeRemoteRequestPathname(raw: string): string {
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

function authorize(req: IncomingMessage, url: URL, token: string): boolean {
  const auth = (req.headers.authorization || '').trim();
  if (auth === `Bearer ${token}`) return true;
  if (url.searchParams.get('t') === token) return true;
  return false;
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
    if (!publicShellGet && !authorize(req, url, token)) {
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
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const modelId =
        typeof body.modelId === 'string'
          ? body.modelId.trim()
          : typeof body.modelId === 'number'
            ? String(body.modelId)
            : '';
      if (!modelId) {
        sendJson(res, 400, { error: 'modelId required' });
        return;
      }
      await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        const id = JSON.parse(${JSON.stringify(JSON.stringify(modelId))});
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
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const sessionId =
        typeof body.sessionId === 'string'
          ? body.sessionId.trim()
          : typeof body.sessionId === 'number'
            ? String(body.sessionId)
            : '';
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
          const payload = JSON.parse(${JSON.stringify(JSON.stringify({ sessionId: sessionId as string, messageIds }))});
          await bridge.removeChatMessagesRemote(payload);
        }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/messages/patch') {
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const sessionId =
        typeof body.sessionId === 'string'
          ? body.sessionId.trim()
          : typeof body.sessionId === 'number'
            ? String(body.sessionId)
            : '';
      const messageId =
        typeof body.messageId === 'string'
          ? body.messageId.trim()
          : typeof body.messageId === 'number'
            ? String(body.messageId)
            : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!sessionId || !messageId) {
        sendJson(res, 400, { error: 'sessionId and messageId required' });
        return;
      }
      await invokeBridge(`async () => {
          const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
          const payload = JSON.parse(${JSON.stringify(JSON.stringify({ sessionId, messageId, content }))});
          await bridge.patchChatMessageRemote(payload);
        }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/messages/resubmit') {
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const sessionId =
        typeof body.sessionId === 'string'
          ? body.sessionId.trim()
          : typeof body.sessionId === 'number'
            ? String(body.sessionId)
            : '';
      const messageId =
        typeof body.messageId === 'string'
          ? body.messageId.trim()
          : typeof body.messageId === 'number'
            ? String(body.messageId)
            : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!sessionId || !messageId) {
        sendJson(res, 400, { error: 'sessionId and messageId required' });
        return;
      }
      await invokeBridge(`async () => {
          const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
          const payload = JSON.parse(${JSON.stringify(JSON.stringify({ sessionId, messageId, content }))});
          await bridge.resubmitEditedUserMessageRemote(payload);
        }`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathNorm === '/remote/api/media-library/delete') {
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
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
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const sessionId =
        typeof body.sessionId === 'string'
          ? body.sessionId.trim()
          : typeof body.sessionId === 'number'
            ? String(body.sessionId)
            : '';
      if (!sessionId) {
        sendJson(res, 400, { error: 'sessionId required' });
        return;
      }
      await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        const sid = JSON.parse(${JSON.stringify(JSON.stringify(sessionId))});
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
      const raw = await collectBody(req, BODY_JSON_CAP);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const sessionId =
        typeof body.sessionId === 'string' ? body.sessionId.trim() : typeof body.sessionId === 'number' ? String(body.sessionId) : '';
      const content = typeof body.content === 'string' ? body.content : '';
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      /** 异步执行：即刻返回；桌面端沿用流式 SSE，远端通过轮询 /state 拉取增量内容 */
      await invokeBridge(`async () => {
        const bridge = window.__MYAGENT_REMOTE_BRIDGE__;
        const payload = JSON.parse(${JSON.stringify(JSON.stringify({ sessionId, content, attachments }))});
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
    sendJson(res, 500, { error: msg || 'internal' });
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
      if (!inst) return reject(new Error('no server'));
      inst.once('error', reject);
      inst.listen(cfg.port, '0.0.0.0', () => {
        inst!.off('error', reject);
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

let ipcRegistered = false;

export async function bootstrapRemoteGatewayFromDisk(): Promise<void> {
  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.removeHandler('remote-gateway-get-config');
    ipcMain.handle('remote-gateway-get-config', async () => await loadOrCreateConfig());
    ipcMain.removeHandler('remote-gateway-set-config');
    ipcMain.handle(
      'remote-gateway-set-config',
      async (
        _e,
        patch: Partial<
          Pick<RemoteGatewayFileConfig, 'enabled' | 'port' | 'token'> & { regenerateToken?: boolean }
        >
      ) => {
        let base = activeConfig ?? (await loadOrCreateConfig());
        const next = mergeRemoteGatewayPatch(base, patch ?? {});
        await persistConfig(next);
        await applyRemoteGatewayListening(next);
        return next;
      }
    );
  }
  const cfg = await loadOrCreateConfig();
  await applyRemoteGatewayListening(cfg);
}
