import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { URL as NodeURL } from 'node:url';
import { type ModelConfig, ImageGenerationParams } from '../../src/types';
import {
  isUnsetImageProvider,
  resolveImageProviderId,
  type InferredImageProviderId,
} from '../../src/utils/imageProviderPresets';

/** CLI 子进程 stdout/stderr 合并上限，避免海量日志撑爆主进程内存导致假死 */
const MAX_CLI_COMBINED_LOG_CHARS = 200_000;

function appendCappedCliLog(acc: string, chunk: Buffer | string): string {
  if (acc.length >= MAX_CLI_COMBINED_LOG_CHARS) return acc;
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const room = MAX_CLI_COMBINED_LOG_CHARS - acc.length;
  return acc + (s.length <= room ? s : `${s.slice(0, room)}\n…[CLI 输出已截断]\n`);
}

/** 清洗粘贴进来的密钥（引号、零宽字符、换行空白） */
function sanitizeSecretToken(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, '');
}

/**
 * 生图环境变量中 `HEADER_<名称>` 形如 `HEADER_AUTHORIZATION=Bearer xxx` → HTTP 请求头 `Authorization`.
 * （名称段按分段首字母大写并 `-` 连接，如 HEADER_X_API_KEY→X-Api-Key）
 */
function normalizeBearerAuthorization(headerValue: string): string {
  const t = sanitizeSecretToken(headerValue);
  if (!t) return t;
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

function hasExplicitAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
}

function getAuthorizationHeaderValue(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      const t = String(v ?? '').trim();
      return t || undefined;
    }
  }
  return undefined;
}

function secretKeyHint(authorizationOrRaw: string | undefined): string {
  if (!authorizationOrRaw) return '';
  const k = sanitizeSecretToken(authorizationOrRaw.replace(/^bearer\s+/i, ''));
  if (!k) return '';
  if (k.length <= 4) return '****';
  return `…${k.slice(-4)}`;
}

/**
 * 按候选 env key 顺序查找裸 API Key 并规范化为 Bearer。
 * 不同厂商候选 key 不同，集中收敛，避免散落。
 */
function bearerFromEnvCandidates(
  env: Record<string, string> | undefined,
  candidates: string[]
): string | undefined {
  if (!env) return undefined;
  for (const k of candidates) {
    const raw = typeof env[k] === 'string' ? sanitizeSecretToken(env[k]) : '';
    if (raw) return normalizeBearerAuthorization(raw);
  }
  return undefined;
}

function firstMatchingEnvKey(
  env: Record<string, string> | undefined,
  candidates: string[]
): string | undefined {
  if (!env) return undefined;
  for (const k of candidates) {
    const raw = typeof env[k] === 'string' ? sanitizeSecretToken(env[k]) : '';
    if (raw) return k;
  }
  return undefined;
}

/** 火山方舟：ARK_API_KEY 及历史别名 */
const VOLC_API_KEY_CANDIDATES = ['ARK_API_KEY', 'VOLC_ENGINE_API_KEY', 'VOLCES_API_KEY', 'VOLC_IMAGE_API_KEY'];
/** 百炼 DashScope */
const BAILIAN_API_KEY_CANDIDATES = ['DASHSCOPE_API_KEY', 'BAILIAN_API_KEY', 'ALIYUN_API_KEY'];
/** OpenAI 及通用 */
const OPENAI_API_KEY_CANDIDATES = ['OPENAI_API_KEY', 'REMOTE_API_KEY'];
/** 智谱 BigModel */
const ZHIPU_API_KEY_CANDIDATES = ['ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY'];
/** MiniMax */
const MINIMAX_API_KEY_CANDIDATES = ['MINIMAX_API_KEY', 'MINIMAX_TOKEN'];

/**
 * 解析有效生图厂商：显式非 custom 优先，否则按 Endpoint/httpFormat 推断。
 */
function effectiveImageProvider(
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  endpoint?: string
): InferredImageProviderId | undefined {
  const ep = (endpoint ?? config.endpoint ?? '').trim();
  const formatHint =
    config.httpFormat && config.httpFormat !== 'auto' ? config.httpFormat : undefined;
  return resolveImageProviderId(config.provider, ep, formatHint);
}

/**
 * 解析生图鉴权 Bearer：
 * 1) 结构化 config.apiKey 优先；
 * 2) 否则按「显式或 Endpoint 推断」的厂商选 env key；
 * 3) 仍未知时尝试常见云厂商 env 全集。
 *
 * 结果优先于 HEADER_AUTHORIZATION（见 mergedCustomHeadersForImageHttp）。
 */
function resolveProviderBearer(
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  env: Record<string, string> | undefined
): string | undefined {
  const structured = typeof config.apiKey === 'string' ? sanitizeSecretToken(config.apiKey) : '';
  if (structured) return normalizeBearerAuthorization(structured);

  const provider = effectiveImageProvider(config);
  switch (provider) {
    case 'bailian-wanx':
      return bearerFromEnvCandidates(env, BAILIAN_API_KEY_CANDIDATES);
    case 'volc-seedream':
      return bearerFromEnvCandidates(env, VOLC_API_KEY_CANDIDATES);
    case 'openai-images':
      return (
        bearerFromEnvCandidates(env, OPENAI_API_KEY_CANDIDATES) ??
        bearerFromEnvCandidates(env, VOLC_API_KEY_CANDIDATES)
      );
    case 'zhipu-cogview':
      return bearerFromEnvCandidates(env, ZHIPU_API_KEY_CANDIDATES);
    case 'minimax':
      return bearerFromEnvCandidates(env, MINIMAX_API_KEY_CANDIDATES);
    case 'ollama':
    case 'sdwebui':
      return undefined;
    default:
      return (
        bearerFromEnvCandidates(env, OPENAI_API_KEY_CANDIDATES) ??
        bearerFromEnvCandidates(env, BAILIAN_API_KEY_CANDIDATES) ??
        bearerFromEnvCandidates(env, MINIMAX_API_KEY_CANDIDATES) ??
        bearerFromEnvCandidates(env, ZHIPU_API_KEY_CANDIDATES) ??
        bearerFromEnvCandidates(env, VOLC_API_KEY_CANDIDATES)
      );
  }
}

type ImageHttpAuthMeta = {
  source: string;
  keyHint: string;
};

function describeImageHttpAuth(
  config: NonNullable<ModelConfig['imageGeneratorConfig']> | undefined,
  env: Record<string, string> | undefined,
  headers: Record<string, string>
): ImageHttpAuthMeta {
  const auth = getAuthorizationHeaderValue(headers);
  const hint = secretKeyHint(auth);
  if (config) {
    const structured = typeof config.apiKey === 'string' ? sanitizeSecretToken(config.apiKey) : '';
    if (structured) {
      return { source: '生图「API 密钥」字段', keyHint: secretKeyHint(structured) || hint };
    }
    let envKey: string | undefined;
    switch (effectiveImageProvider(config)) {
      case 'bailian-wanx':
        envKey = firstMatchingEnvKey(env, BAILIAN_API_KEY_CANDIDATES);
        break;
      case 'volc-seedream':
        envKey = firstMatchingEnvKey(env, VOLC_API_KEY_CANDIDATES);
        break;
      case 'openai-images':
        envKey =
          firstMatchingEnvKey(env, OPENAI_API_KEY_CANDIDATES) ??
          firstMatchingEnvKey(env, VOLC_API_KEY_CANDIDATES);
        break;
      case 'zhipu-cogview':
        envKey = firstMatchingEnvKey(env, ZHIPU_API_KEY_CANDIDATES);
        break;
      case 'minimax':
        envKey = firstMatchingEnvKey(env, MINIMAX_API_KEY_CANDIDATES);
        break;
      default:
        envKey =
          firstMatchingEnvKey(env, OPENAI_API_KEY_CANDIDATES) ??
          firstMatchingEnvKey(env, BAILIAN_API_KEY_CANDIDATES) ??
          firstMatchingEnvKey(env, MINIMAX_API_KEY_CANDIDATES) ??
          firstMatchingEnvKey(env, ZHIPU_API_KEY_CANDIDATES) ??
          firstMatchingEnvKey(env, VOLC_API_KEY_CANDIDATES);
        break;
    }
    if (envKey) return { source: `环境变量 ${envKey}`, keyHint: hint };
  }
  if (hasExplicitAuthorizationHeader(extraHttpHeadersFromImageEnv(env))) {
    return { source: '环境变量 HEADER_AUTHORIZATION', keyHint: hint };
  }
  if (auth) return { source: 'Authorization 请求头', keyHint: hint };
  return { source: '未携带', keyHint: '' };
}

function mergedCustomHeadersForImageHttp(
  env: Record<string, string> | undefined,
  config?: NonNullable<ModelConfig['imageGeneratorConfig']>
): Record<string, string> {
  const merged = extraHttpHeadersFromImageEnv(env);
  /** 结构化 apiKey / 厂商 env key 优先于 HEADER_AUTHORIZATION，避免发错 Bearer */
  const fromProvider = config
    ? resolveProviderBearer(config, env)
    : bearerFromEnvCandidates(env, VOLC_API_KEY_CANDIDATES);
  if (fromProvider) {
    merged.Authorization = fromProvider;
  }
  return merged;
}

function headerNameFromEnvSuffix(suffixRaw: string): string {
  const suffix = suffixRaw.replace(/[^\w_-]/g, '');
  const parts = suffix.split(/[_-]+/).filter(Boolean);
  if (!parts.length) return suffixRaw.trim();
  return parts
    .map((p) => (p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join('-');
}

function extraHttpHeadersFromImageEnv(env: Record<string, string> | undefined): Record<string, string> {
  const extra: Record<string, string> = {};
  if (!env) return extra;
  for (const [k0, val] of Object.entries(env)) {
    const trimmedKey = k0.trim();
    if (!/^HEADER_/i.test(trimmedKey)) continue;
    const suffix = trimmedKey.slice('HEADER_'.length).trim();
    if (!suffix) continue;
    const name = headerNameFromEnvSuffix(suffix);
    if (!name) continue;
    const v = String(val ?? '').trim();
    if (v)
      extra[name] = name.toLowerCase() === 'authorization' ? normalizeBearerAuthorization(v) : v;
  }
  return extra;
}

/** 全应用单次只跑一个生图 IPC，避免多张并行 CLI/HTTP 抢占 GPU 或卡住主线程 */
let imageGenerationQueueTail: Promise<void> = Promise.resolve();

function enqueueSerializedImageGeneration<T>(job: () => Promise<T>): Promise<T> {
  const run = imageGenerationQueueTail.then(job);
  imageGenerationQueueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 本机 diffusers + `enable_model_cpu_offload` 等路径下，实测 512² / 4 步可超 10 分钟；
 * 默认 15 分钟；更大分辨率或首包下载请用环境变量调大。
 * @see MYAGENT_IMAGE_GEN_TIMEOUT_MS（毫秒，范围 60s–120min）
 * @see MYAGENT_IMAGE_GEN_FALLBACK_MS（Node 兜底 POST 单独限时，默认 min(主超时,3min)）
 */
function resolveImageGenTimeoutMs(): number {
  const raw = process.env.MYAGENT_IMAGE_GEN_TIMEOUT_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) {
      const clamped = Math.min(Math.max(n, 60_000), 120 * 60 * 1000);
      return clamped;
    }
  }
  return 15 * 60 * 1000;
}

const IMAGE_GEN_TIMEOUT_MS = resolveImageGenTimeoutMs();

/**
 * 兜底 POST 单独限时：避免首包 fetch 与二次 Node 请求各占满主超时，体感「整应用卡死」。
 * @see MYAGENT_IMAGE_GEN_FALLBACK_MS（毫秒，不小于 30s、不超过主超时）
 */
function resolveImageGenFallbackMs(mainMs: number): number {
  const raw = process.env.MYAGENT_IMAGE_GEN_FALLBACK_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) {
      return Math.min(Math.max(n, 30_000), mainMs);
    }
  }
  return Math.min(mainMs, 3 * 60 * 1000);
}

const IMAGE_GEN_FALLBACK_MS = resolveImageGenFallbackMs(IMAGE_GEN_TIMEOUT_MS);

function resolveOllamaEmptyProbeMs(): number {
  const raw = process.env.MYAGENT_OLLAMA_EMPTY_PROBE_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 5_000), IMAGE_GEN_TIMEOUT_MS);
  }
  return Math.min(IMAGE_GEN_TIMEOUT_MS, 20_000);
}

const OLLAMA_EMPTY_PROBE_MS = resolveOllamaEmptyProbeMs();

/**
 * Fetch/Undici 在「HTTP 200 + Content-Length: 0」与 chunked body 并存时可能读到空 body；
 * Node 原生 http 会完整拼接收到的分块，用于兜底。
 *
 * 使用绝对硬超时 + single-settle，响应体久不结束时会 destroy，避免主进程 IPC 永久挂起。
 */
function nodeRawPostJsonBody(
  endpoint: string,
  bodyJson: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string>
): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const u = new NodeURL(endpoint);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

  return new Promise((resolve, reject) => {
    let settled = false;
    let resIncoming: http.IncomingMessage | null = null;
    let req!: http.ClientRequest;

    const settleOk = (payload: {
      statusCode: number;
      headers: IncomingHttpHeaders;
      body: Buffer;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      try {
        resIncoming?.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        req.removeAllListeners();
      } catch {
        /* ignore */
      }
      resolve(payload);
    };

    const settleErr = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      try {
        resIncoming?.removeAllListeners();
        resIncoming?.destroy();
      } catch {
        /* ignore */
      }
      try {
        req.removeAllListeners();
        req.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const hardKill = setTimeout(() => {
      settleErr(
        new Error(
          `生图兜底超时（>${Math.round(timeoutMs / 60_000)} 分钟）；可调 MYAGENT_IMAGE_GEN_FALLBACK_MS 或 MYAGENT_IMAGE_GEN_TIMEOUT_MS`
        )
      );
    }, timeoutMs);

    const chunks: Buffer[] = [];

    req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyJson, 'utf8'),
          Accept: 'application/json, application/x-ndjson, text/event-stream, image/png, image/*, */*',
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        resIncoming = res;
        res.on('data', (c: string | Buffer) => {
          chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
        });
        res.on('end', () =>
          settleOk({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', (e) => settleErr(e instanceof Error ? e : new Error(String(e))));
      }
    );

    req.on('error', (e) => settleErr(e));
    req.write(bodyJson, 'utf8');
    req.end();
  });
}

function looksLikeWindowsExec(cmd: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(cmd.trim());
}

/** 占位符替换；prompt 可能含特殊字符，按「整段 argv」传入 */
function applyCliPlaceholders(
  line: string,
  params: ImageGenerationParams,
  outputPath: string
): string {
  const w = String(params.width ?? 512);
  const h = String(params.height ?? 512);
  const count = String(params.count ?? 1);
  const steps = String((params as { steps?: number }).steps ?? process.env.MYAGENT_SD_STEPS ?? 20);
  const p = params.prompt ?? '';
  return line
    .replace(/\{\{prompt\}\}/g, p)
    .replace(/\{\{outputPath\}\}/g, outputPath)
    .replace(/\{\{width\}\}/g, w)
    .replace(/\{\{height\}\}/g, h)
    .replace(/\{\{count\}\}/g, count)
    .replace(/\{\{steps\}\}/g, steps);
}

/** 整块响应已为 PNG/JPEG/WebP（避免 JSON 误判或「原始格式」误判） */
function looksLikeBinaryImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return true;
  return false;
}

/** data URL / 空白 → 二进制；长度校验避免误解码短串 */
function base64FieldToImageBuffer(raw: string | undefined): Buffer | null {
  if (typeof raw !== 'string' || raw.length < 32) return null;
  let s = raw.trim().replace(/\s/g, '');
  const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  try {
    const buf = Buffer.from(s, 'base64');
    /** PNG / JPEG WebP magic */
    if (buf.length < 64) return null;
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    )
      return buf;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return buf;
    if (
      buf.length >= 12 &&
      buf.slice(0, 4).toString() === 'RIFF' &&
      buf.slice(8, 12).toString() === 'WEBP'
    )
      return buf;
    return buf.length >= 320 ? buf : null;
  } catch {
    return null;
  }
}

const MAX_JSON_IMAGE_SCAN_DEPTH = 14;

/** 兜底：递归查找任意字符串里的 base64 图（适配非标准字段名或嵌套结构） */
function extractImageDeepScan(
  val: unknown,
  depth = 0,
  seen?: WeakSet<object>
): Buffer | null {
  if (depth > MAX_JSON_IMAGE_SCAN_DEPTH) return null;
  if (typeof val === 'string') {
    return val.length >= 48 ? base64FieldToImageBuffer(val) : null;
  }
  if (!val || typeof val !== 'object') return null;
  if (!seen) seen = new WeakSet<object>();
  if (seen.has(val)) return null;
  seen.add(val);

  if (Array.isArray(val)) {
    for (let i = val.length - 1; i >= 0; i--) {
      const b = extractImageDeepScan(val[i], depth + 1, seen);
      if (b) return b;
    }
    return null;
  }
  for (const v of Object.values(val as Record<string, unknown>)) {
    const b = extractImageDeepScan(v, depth + 1, seen);
    if (b) return b;
  }
  return null;
}

/** 从 HTTP JSON 中提取第一张 PNG/JPEG base64 */
function extractImageBufferFromJson(
  data: unknown,
  mode: 'sdwebui' | 'ollama' | 'auto'
): Buffer | null {
  if (Array.isArray(data)) {
    for (let i = data.length - 1; i >= 0; i--) {
      const b = extractImageBufferFromJson(data[i], mode);
      if (b) return b;
    }
    return extractImageDeepScan(data);
  }
  if (!data || typeof data !== 'object') return null;
  const j = data as Record<string, unknown>;

  /** 常见于 OpenAI/兼容网关、网关包装层 */
  for (const k of [
    'data',
    'b64_json',
    'picture',
    'picture_base64',
    'output',
    'result',
    'buffer',
    'artifact',
    'file',
    'payload',
    'content',
    'body',
    'img',
    'b64',
    'base64',
  ] as const) {
    const v = j[k];
    if (typeof v === 'string') {
      const b = base64FieldToImageBuffer(v);
      if (b) return b;
    }
  }

  const imgVal =
    typeof j.image === 'string'
      ? j.image
      : typeof j.Image === 'string'
        ? j.Image
        : undefined;

  if (mode === 'sdwebui' || mode === 'auto') {
    const imgs = j.images;
    if (Array.isArray(imgs) && typeof imgs[0] === 'string') {
      const b = base64FieldToImageBuffer(imgs[0]);
      if (b) return b;
    }
    const b1 = imgVal ? base64FieldToImageBuffer(imgVal) : null;
    if (b1) return b1;
  }

  if (mode === 'ollama' || mode === 'auto') {
    if (imgVal) {
      const b = base64FieldToImageBuffer(imgVal);
      if (b) return b;
    }
    const resp = j.response;
    if (typeof resp === 'string') {
      const b = base64FieldToImageBuffer(resp);
      if (b) return b;
    }
    const msg = j.message as Record<string, unknown> | undefined;
    const arr = msg?.images ?? j.images;
    if (Array.isArray(arr) && typeof arr[0] === 'string') {
      const b = base64FieldToImageBuffer(arr[0]);
      if (b) return b;
    }
  }

  return extractImageDeepScan(data);
}

/** UTF-8 BOM */
function stripUtf8Bom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

/** 方舟豆包示例 API：POST …/volces…/images/generations */
function isVolcArkImageGenerationsEndpoint(endpoint: string): boolean {
  return /\bvolces\.com\b/i.test(endpoint) && /images\/generations/i.test(endpoint);
}

function parseEnvBoolFlexible(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined || String(raw).trim() === '') return defaultVal;
  const s = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return defaultVal;
}

function parseArkImageFieldFromEnv(env: Record<string, string> | undefined): string | string[] | undefined {
  if (!env) return undefined;
  const raw = (
    env.ARK_IMAGE ||
    env.ARK_IMAGES ||
    env.IMAGE ||
    env.REFERENCE_IMAGE ||
    env.IMAGE_INPUT ||
    ''
  ).trim();
  if (!raw) return undefined;
  if (raw.startsWith('[')) {
    try {
      const j = JSON.parse(raw) as unknown;
      if (Array.isArray(j) && j.every((x) => typeof x === 'string')) return j as string[];
    } catch {
      /* fallthrough 单 URL */
    }
  }
  return raw;
}

function imageMimeFromPath(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

async function normalizeReferenceImageForApi(ref: string): Promise<string | null> {
  const s = String(ref || '').trim();
  if (!s) return null;
  if (/^(https?:|data:)/i.test(s)) return s;
  try {
    const buf = await fs.readFile(s);
    return `data:${imageMimeFromPath(s)};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('[生图 HTTP] 参考图读取失败，已跳过:', s, e instanceof Error ? e.message : e);
    return null;
  }
}

async function normalizeReferenceImagesForApi(params: ImageGenerationParams): Promise<string[]> {
  /** 火山组图约束：参考图 + 输出图总数最多 15；保留至少 1 个输出名额 */
  const refs = Array.isArray(params.referenceImages) ? params.referenceImages.slice(0, 14) : [];
  const normalized = await Promise.all(refs.map((r) => normalizeReferenceImageForApi(r)));
  return normalized.filter((r): r is string => Boolean(r));
}

/**
 * 火山方舟豆包 images/generations 的 `size` 常为 1K/2K/4K 或 WxH（视模型文档）。
 * 无显式环境变量时按请求宽高推断档位，避免写死 2K。
 */
function inferVolcArkDoubaoSizeFromParams(
  params: ImageGenerationParams,
  fallback: string
): string {
  const w = params.width;
  const h = params.height;
  const ok =
    typeof w === 'number' &&
    typeof h === 'number' &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0;
  if (!ok) return fallback;

  const longSide = Math.max(w, h);
  const mp = (w * h) / 1_000_000;
  if (longSide <= 1536 && mp <= 2.2) return '1K';
  if (longSide <= 2816 && mp <= 8.5) return '2K';
  return '4K';
}

function inferArkStreamFlag(env: Record<string, string> | undefined, sequential: string): boolean {
  const ex = (env?.ARK_STREAM || '').trim().toLowerCase();
  if (ex === 'true' || ex === '1' || ex === 'yes' || ex === 'on') return true;
  if (ex === 'false' || ex === '0' || ex === 'no' || ex === 'off') return false;
  const s = sequential.trim().toLowerCase();
  /** 官方豆包：文生多图 / 图生多图 / 多图生多图在 sequential_image_generation=auto 时使用 stream:true */
  return s === 'auto';
}

async function arkVolcDoubaoCompatibleRequestBody(
  env: Record<string, string> | undefined,
  model: string,
  params: ImageGenerationParams
): Promise<Record<string, unknown>> {
  const refImages = await normalizeReferenceImagesForApi(params);
  const imgEarly = refImages.length > 0
    ? refImages
    : parseArkImageFieldFromEnv(env);

  const explicitSeqRaw = (
    env?.SEQUENTIAL_IMAGE_GENERATION ||
    env?.ARK_SEQUENTIAL_IMAGE_GENERATION ||
    ''
  ).trim();

  let seq = explicitSeqRaw;
  const requestedCount =
    typeof params.count === 'number' && Number.isFinite(params.count) && params.count > 0
      ? Math.round(params.count)
      : 1;
  /** ARK_MAX_IMAGES/MAX_IMAGES 作为上限，不再作为“默认生成多图”的开关 */
  const configuredMaxRaw = env?.ARK_MAX_IMAGES ?? env?.MAX_IMAGES ?? '';
  const configuredMax = parseInt(String(configuredMaxRaw), 10);

  const wantsMultiOutputs = requestedCount > 1;

  if (!seq) {
    if (wantsMultiOutputs) seq = 'auto';
    else seq = 'disabled';
  }

  const responseFormat =
    (env?.RESPONSE_FORMAT || env?.IMAGE_RESPONSE_FORMAT || '').trim() || 'url';

  const envSize = (
    env?.ARK_SIZE ||
    env?.IMAGE_SIZE ||
    env?.VOLC_IMAGE_SIZE ||
    env?.ARK_DEFAULT_SIZE ||
    ''
  ).trim();
  const sizeFallback =
    (env?.ARK_DEFAULT_SIZE_FALLBACK || env?.ARK_FALLBACK_SIZE || '').trim().replace(/\s+/g, '') ||
    '2K';
  const size = envSize || inferVolcArkDoubaoSizeFromParams(params, sizeFallback);

  let seqOptions: Record<string, unknown> | undefined;
  const optRaw = (env?.ARK_SEQUENTIAL_OPTIONS || env?.SEQUENTIAL_IMAGE_GENERATION_OPTIONS || '').trim();
  if (optRaw.startsWith('{')) {
    try {
      seqOptions = JSON.parse(optRaw) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  if (
    seq.trim().toLowerCase() === 'auto' &&
    (!seqOptions || Object.keys(seqOptions).length === 0)
  ) {
    const refCount = Array.isArray(imgEarly) ? imgEarly.filter(Boolean).length : imgEarly ? 1 : 0;
    const envCap = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 8;
    const cappedMax = Math.max(1, Math.min(requestedCount, envCap, 15 - refCount));
    seqOptions = { max_images: cappedMax };
  }

  const stream = inferArkStreamFlag(env, seq);

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt ?? '',
    sequential_image_generation: seq,
    response_format: responseFormat,
    size,
    stream,
    watermark: parseEnvBoolFlexible(env?.ARK_WATERMARK, false),
  };

  if (seqOptions && Object.keys(seqOptions).length > 0) {
    body.sequential_image_generation_options = seqOptions;
  }

  if (imgEarly !== undefined) {
    body.image = Array.isArray(imgEarly) && imgEarly.length === 1 ? imgEarly[0] : imgEarly;
  }

  return body;
}

type HttpImageMode = 'sdwebui' | 'ollama' | 'raw' | 'openai_images' | 'auto';

type UnifiedImageRequest = {
  prompt: string;
  width?: number;
  height?: number;
  count: number;
  referenceImages: string[];
  params: ImageGenerationParams;
};

type BuiltImageHttpRequest = {
  provider: string;
  mode: HttpImageMode;
  endpoint: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  readBodyAsStreamingText?: boolean;
  volcOpenAi?: boolean;
  ollamaModel?: string;
};

type HttpImageProviderAdapter = {
  id: string;
  match: (ctx: {
    mode: HttpImageMode;
    endpoint: string;
    config: NonNullable<ModelConfig['imageGeneratorConfig']>;
  }) => boolean;
  build: (ctx: {
    endpoint: string;
    config: NonNullable<ModelConfig['imageGeneratorConfig']>;
    env: Record<string, string> | undefined;
    request: UnifiedImageRequest;
    headers: Record<string, string>;
  }) => Promise<BuiltImageHttpRequest> | BuiltImageHttpRequest;
};

function buildUnifiedImageRequest(params: ImageGenerationParams): UnifiedImageRequest {
  const count =
    typeof params.count === 'number' && Number.isFinite(params.count) && params.count > 0
      ? Math.max(1, Math.round(params.count))
      : 1;
  return {
    prompt: params.prompt ?? '',
    width: params.width,
    height: params.height,
    count,
    referenceImages: Array.isArray(params.referenceImages) ? params.referenceImages : [],
    params,
  };
}

function resolveOpenAiCompatibleImageModel(
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  env: Record<string, string> | undefined,
  volcArk: boolean
): string {
  /** 结构化 config.model 优先（新）；其次 env 厂商候选 key（向后兼容） */
  const structured = typeof config.model === 'string' ? config.model.trim() : '';
  if (structured) return structured;

  const modelEnv =
    env?.REMOTE_IMAGE_MODEL ||
    env?.IMAGE_MODEL ||
    env?.ARK_IMAGE_MODEL ||
    env?.DOUBAO_IMAGE_MODEL ||
    '';
  const model =
    typeof modelEnv === 'string' ? modelEnv.trim() : String(modelEnv ?? '').trim();
  if (!model) {
    const example = volcArk ? 'doubao-seedream-4-5-251128' : 'gpt-image-1';
    throw new Error(
      `OpenAI Images 请填写模型名（设置中的「模型名」或环境变量 \`REMOTE_IMAGE_MODEL\`/\`IMAGE_MODEL\`，例：${example}）。鉴权可用「API 密钥」字段、\`ARK_API_KEY=…\` 或 \`HEADER_AUTHORIZATION=Bearer …\`。`
    );
  }
  return model;
}

const volcSeedreamAdapter: HttpImageProviderAdapter = {
  id: 'volc-seedream',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'volc-seedream' ||
    (isUnsetImageProvider(config.provider) &&
      mode === 'openai_images' &&
      isVolcArkImageGenerationsEndpoint(endpoint)),
  async build({ endpoint, config, env, request, headers }) {
    if (!hasExplicitAuthorizationHeader(headers)) {
      throw new Error(
        '火山方舟返回 401 多为鉴权未带上：请在生图模型「API 密钥」字段填写密钥，或在「环境变量」中填写 `ARK_API_KEY=你的密钥`（等价于 curl 的 Bearer），或填写 `HEADER_AUTHORIZATION=Bearer 你的密钥`；不要使用对话模型的 Key 占位。'
      );
    }
    const model = resolveOpenAiCompatibleImageModel(config, env, true);
    const body = await arkVolcDoubaoCompatibleRequestBody(env, model, request.params);
    return {
      provider: 'volc-seedream',
      mode: 'openai_images',
      endpoint,
      body,
      readBodyAsStreamingText: Boolean(body.stream),
      volcOpenAi: true,
    };
  },
};

const openAiImagesAdapter: HttpImageProviderAdapter = {
  id: 'openai-images',
  match: ({ endpoint, config }) => {
    const id = effectiveImageProvider(config, endpoint);
    return id === 'openai-images' || id === 'zhipu-cogview';
  },
  build({ endpoint, config, env, request }) {
    const model = resolveOpenAiCompatibleImageModel(config, env, false);
    /** 智谱 CogView 只返回 URL（不支持 b64_json），强制用 url */
    const isZhipu =
      effectiveImageProvider(config, endpoint) === 'zhipu-cogview' ||
      /\bbigmodel\.cn\b/i.test(endpoint);
    const rf = isZhipu
      ? 'url'
      : (env?.IMAGE_RESPONSE_FORMAT || env?.RESPONSE_FORMAT || '').trim() || 'b64_json';
    let size =
      typeof request.width === 'number' &&
      request.width > 0 &&
      typeof request.height === 'number' &&
      request.height > 0
        ? `${Math.round(request.width)}x${Math.round(request.height)}`
        : '1024x1024';
    const forcedSize = (env?.ARK_SIZE || env?.IMAGE_SIZE || '').trim();
    if (forcedSize) size = forcedSize;
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      size,
      response_format: rf === 'url' ? 'url' : 'b64_json',
    };
    if (request.count > 1) body.n = Math.max(1, Math.min(10, request.count));
    return { provider: isZhipu ? 'zhipu-cogview' : 'openai-images', mode: 'openai_images', endpoint, body };
  },
};

const sdWebUiAdapter: HttpImageProviderAdapter = {
  id: 'sdwebui',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'sdwebui' ||
    (isUnsetImageProvider(config.provider) && mode === 'sdwebui'),
  build({ endpoint, request }) {
    return {
      provider: 'sdwebui',
      mode: 'sdwebui',
      endpoint,
      body: {
        prompt: request.prompt,
        negative_prompt: '',
        steps: 25,
        width: request.width || 512,
        height: request.height || 512,
        cfg_scale: 7,
        sampler_index: 'Euler a',
        n_iter: 1,
        batch_size: Math.max(1, Math.min(8, request.count)),
      },
    };
  },
};

const ollamaAdapter: HttpImageProviderAdapter = {
  id: 'ollama',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'ollama' ||
    (isUnsetImageProvider(config.provider) && mode === 'ollama'),
  build({ endpoint, config, env, request }) {
    /** config.model 优先（新），其次 env（向后兼容） */
    const model =
      (typeof config.model === 'string' ? config.model.trim() : '') ||
      env?.OLLAMA_MODEL ||
      env?.ollama_model ||
      'flux';
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      stream: false,
    };
    if (typeof request.width === 'number' && request.width > 0) body.width = request.width;
    if (typeof request.height === 'number' && request.height > 0) body.height = request.height;
    return { provider: 'ollama', mode: 'ollama', endpoint, body, ollamaModel: model };
  },
};

const rawAutoAdapter: HttpImageProviderAdapter = {
  id: 'raw-auto',
  match: () => true,
  build({ endpoint, request }) {
    return {
      provider: 'raw-auto',
      mode: 'auto',
      endpoint,
      body: {
        prompt: request.prompt,
        width: request.width,
        height: request.height,
      },
    };
  },
};

/**
 * 百炼/万相响应解析（wan2.6 同步协议）：
 * { output: { choices: [ { message: { content: [ { image: "url", type: "image" } ] } } ] } }
 * 兼容旧版异步轮询结构 { output: { results: [ { url } ] } } 作为兜底。
 */
function extractImagesFromBailianResponse(data: unknown): { urls: string[]; b64s: string[] } {
  const urls: string[] = [];
  const b64s: string[] = [];
  const pushUrl = (u: unknown) => {
    const s = typeof u === 'string' ? u.trim() : '';
    if (/^https?:\/\//i.test(s)) urls.push(s);
  };
  const pushB64 = (b: unknown) => {
    const s = typeof b === 'string' ? b.trim() : '';
    if (s.length >= 48) b64s.push(s);
  };

  if (!data || typeof data !== 'object') return { urls, b64s };
  const j = data as Record<string, unknown>;
  const output = j.output as Record<string, unknown> | undefined;

  /** wan2.6 同步：output.choices[].message.content[].image */
  const choices = Array.isArray(output?.choices) ? output!.choices : undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const message = c.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content : undefined;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const ci = item as Record<string, unknown>;
          pushUrl(ci.image);
          pushB64(ci.image);
        }
      }
    }
  }

  /** 兼容旧版异步轮询：output.results[].url */
  const results = Array.isArray(output?.results) ? output!.results : undefined;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      pushUrl(r.url);
      pushB64(r.b64_image);
      pushB64(r.image);
    }
  }

  /** 兜底：递归找任何 image/url 字段 */
  if (!urls.length && !b64s.length) {
    for (const v of Object.values(j)) {
      if (typeof v === 'string') {
        pushUrl(v);
        pushB64(v);
      }
    }
  }
  return { urls, b64s };
}

/**
 * 百炼/万相 wan2.6 size 格式为 "宽*高"（星号分隔），总像素在 [1280*1280, 1440*1440] 之间。
 * 用户未指定时默认 1280*1280；可通过 env.IMAGE_SIZE 覆盖。
 */
function inferBailianWanxSize(params: ImageGenerationParams, env: Record<string, string> | undefined): string {
  const forced = (env?.IMAGE_SIZE || env?.WANX_SIZE || '').trim();
  if (forced) return forced;
  const w = typeof params.width === 'number' && params.width > 0 ? Math.round(params.width) : 1280;
  const h = typeof params.height === 'number' && params.height > 0 ? Math.round(params.height) : 1280;
  return `${w}*${h}`;
}

const bailianWanxAdapter: HttpImageProviderAdapter = {
  id: 'bailian-wanx',
  match: ({ config, endpoint }) => effectiveImageProvider(config, endpoint) === 'bailian-wanx',
  async build({ endpoint, config, env, request, headers }) {
    /** 防御：wan2.6 同步调用必须用 multimodal-generation/generation；旧版 image-synthesis 会返回异步 task_id */
    if (!/multimodal-generation\/generation/i.test(endpoint)) {
      throw new Error(
        '百炼/万相接口地址不正确：wan2.6 同步调用请使用 `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`。请在「高级」中检查或重新选择「百炼/通义万相」预设以自动填入。'
      );
    }
    if (!hasExplicitAuthorizationHeader(headers)) {
      throw new Error(
        '百炼/万相鉴权未带上：请在生图模型「API 密钥」字段填写 DashScope Key，或在「环境变量」中填写 `DASHSCOPE_API_KEY=sk-…`。'
      );
    }
    /** config.model 优先（新），其次 env（向后兼容） */
    const model =
      (typeof config.model === 'string' ? config.model.trim() : '') ||
      env?.REMOTE_IMAGE_MODEL ||
      env?.IMAGE_MODEL ||
      env?.WANX_MODEL ||
      '';
    if (!model) {
      throw new Error(
        '百炼/万相请填写模型名（设置中的「模型名」或环境变量 `REMOTE_IMAGE_MODEL`/`IMAGE_MODEL`，例：wan2.6-t2i）。'
      );
    }
    const size = inferBailianWanxSize(request.params, env);
    const n =
      typeof request.count === 'number' && request.count > 0
        ? Math.max(1, Math.min(4, Math.round(request.count)))
        : 1;
    /** wan2.6 同步协议请求体：input.messages[].content[].text + parameters */
    const body: Record<string, unknown> = {
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: request.prompt ?? '' }],
          },
        ],
      },
      parameters: {
        size,
        n,
        watermark: false,
        prompt_extend: true,
      },
    };
    return { provider: 'bailian-wanx', mode: 'auto', endpoint, body };
  },
};

/**
 * MiniMax 响应：
 * 成功：{ data: { image_urls?: string[], image_base64?: string[] }, base_resp: { status_code: 0 } }
 * 失败：常仅返回 { base_resp: { status_code, status_msg } }（HTTP 仍可能是 200）
 */
function looksLikeMiniMaxResponseJson(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return Object.prototype.hasOwnProperty.call(data, 'base_resp');
}

function formatMiniMaxStatusError(
  statusCode: number,
  statusMsg: string,
  meta?: { host?: string; authSource?: string; keyHint?: string }
): string {
  const hints: Record<number, string> = {
    1002: '触发限流，请稍后重试',
    1004: '账号鉴权失败，请检查 API Key 是否正确、是否填写在生图模型「API 密钥」',
    1008: '账户余额不足，请前往 MiniMax 开放平台充值',
    1026: '提示词含敏感内容，请修改后再试',
    2013: '请求参数无效：请确认模型名为 image-01，Endpoint 为 …/v1/image_generation，宽高比合法',
    2049:
      'API Key 无效或与站点不匹配：请确认密钥填在生图「API 密钥」（不是对话模型密钥）；国内站 Key 配 api.minimaxi.com，国际站 Key 配 api.minimax.io',
  };
  const hint = hints[statusCode] || '请查阅 MiniMax 开放平台错误码说明';
  const detail = statusMsg.trim() ? `，${statusMsg.trim()}` : '';
  let msg = `MiniMax 生图失败（status_code=${statusCode}${detail}）：${hint}`;
  if (statusCode === 2049 && meta) {
    const bits = [
      meta.host ? `host=${meta.host}` : '',
      meta.authSource ? `鉴权来自 ${meta.authSource}` : '',
      meta.keyHint ? `密钥后缀 ${meta.keyHint}` : '',
    ].filter(Boolean);
    if (bits.length) msg += `（${bits.join('；')}）`;
    if (meta.host && /minimaxi\.com/i.test(meta.host)) {
      msg += '。若 Key 来自国际站 platform.minimax.io，请把 Endpoint 改为 https://api.minimax.io/v1/image_generation';
    } else if (meta.host && /minimax\.io/i.test(meta.host)) {
      msg += '。若 Key 来自国内站 platform.minimaxi.com，请把 Endpoint 改为 https://api.minimaxi.com/v1/image_generation';
    }
  }
  return msg;
}

function assertMiniMaxBaseRespOk(
  data: unknown,
  meta?: { host?: string; authSource?: string; keyHint?: string }
): void {
  if (!data || typeof data !== 'object') return;
  const br = (data as Record<string, unknown>).base_resp;
  if (!br || typeof br !== 'object') return;
  const statusCode = Number((br as Record<string, unknown>).status_code);
  if (!Number.isFinite(statusCode) || statusCode === 0) return;
  const statusMsg = String((br as Record<string, unknown>).status_msg ?? '');
  throw new Error(formatMiniMaxStatusError(statusCode, statusMsg, meta));
}

function peekMiniMaxStatusCode(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const br = (data as Record<string, unknown>).base_resp;
  if (!br || typeof br !== 'object') return null;
  const statusCode = Number((br as Record<string, unknown>).status_code);
  return Number.isFinite(statusCode) ? statusCode : null;
}

function extractImagesFromMiniMaxResponse(
  data: unknown,
  meta?: { host?: string; authSource?: string; keyHint?: string }
): { urls: string[]; b64s: string[] } {
  if (!data || typeof data !== 'object') return { urls: [], b64s: [] };
  assertMiniMaxBaseRespOk(data, meta);
  const j = data as Record<string, unknown>;
  const d = (j.data && typeof j.data === 'object' ? j.data : null) as Record<string, unknown> | null;
  const urlsRaw = d?.image_urls;
  const b64Raw = d?.image_base64;
  const urls = Array.isArray(urlsRaw)
    ? urlsRaw.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
    : [];
  const b64s = Array.isArray(b64Raw)
    ? b64Raw.filter((u): u is string => typeof u === 'string' && u.trim().length > 32)
    : [];
  return { urls, b64s };
}

/**
 * 纠正 MiniMax 生图 URL：强制 path=/v1/image_generation；旧 chat 域名改到国际站。
 */
function normalizeMiniMaxImageEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint.trim());
    if (/^api\.minimax\.chat$/i.test(u.hostname)) {
      u.hostname = 'api.minimax.io';
    }
    if (/\bapi\.minimaxi?\.(io|com)\b/i.test(u.hostname)) {
      u.pathname = '/v1/image_generation';
      u.search = '';
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    /* ignore */
  }
  return endpoint.trim();
}

/** 国内/国际站互切（2049 时自动重试） */
function alternateMiniMaxImageEndpoint(endpoint: string): string | null {
  try {
    const u = new URL(normalizeMiniMaxImageEndpoint(endpoint));
    if (/^api\.minimaxi\.com$/i.test(u.hostname)) {
      u.hostname = 'api.minimax.io';
      return u.toString().replace(/\/$/, '');
    }
    if (/^api\.minimax\.io$/i.test(u.hostname)) {
      u.hostname = 'api.minimaxi.com';
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * MiniMax 用宽高比（aspect_ratio）而非像素尺寸；由 width/height 推断最接近的比例。
 */
function inferMiniMaxAspectRatio(params: ImageGenerationParams): string {
  const w = typeof params.width === 'number' && params.width > 0 ? params.width : 1024;
  const h = typeof params.height === 'number' && params.height > 0 ? params.height : 1024;
  if (w === h) return '1:1';
  const ratio = w / h;
  /** 匹配最接近的 MiniMax 支持比例 */
  const candidates: Array<{ ar: string; val: number }> = [
    { ar: '1:1', val: 1 },
    { ar: '16:9', val: 16 / 9 },
    { ar: '9:16', val: 9 / 16 },
    { ar: '4:3', val: 4 / 3 },
    { ar: '3:4', val: 3 / 4 },
    { ar: '3:2', val: 3 / 2 },
    { ar: '2:3', val: 2 / 3 },
  ];
  let best = candidates[0]!;
  let bestDiff = Math.abs(Math.log(ratio / best.val));
  for (const c of candidates) {
    const diff = Math.abs(Math.log(ratio / c.val));
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.ar;
}

const minimaxAdapter: HttpImageProviderAdapter = {
  id: 'minimax',
  match: ({ config, endpoint }) => effectiveImageProvider(config, endpoint) === 'minimax',
  async build({ endpoint, config, env, request, headers }) {
    if (!hasExplicitAuthorizationHeader(headers)) {
      throw new Error(
        'MiniMax 鉴权未带上：请在生图模型「API 密钥」字段填写 MiniMax API Key（同一模型顶部的对话 API 密钥也可作为回退），或在「环境变量」中填写 `MINIMAX_API_KEY=…`。国内站 Endpoint：https://api.minimaxi.com/v1/image_generation ；国际站：https://api.minimax.io/v1/image_generation'
      );
    }
    const model =
      (typeof config.model === 'string' ? config.model.trim() : '') ||
      env?.REMOTE_IMAGE_MODEL ||
      env?.IMAGE_MODEL ||
      'image-01';
    const aspectRatio = inferMiniMaxAspectRatio(request.params);
    const n =
      typeof request.count === 'number' && request.count > 0
        ? Math.max(1, Math.min(9, Math.round(request.count)))
        : 1;
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt ?? '',
      aspect_ratio: aspectRatio,
      response_format: 'url',
      n,
      prompt_optimizer: true,
    };
    return {
      provider: 'minimax',
      mode: 'auto',
      endpoint: normalizeMiniMaxImageEndpoint(endpoint),
      body,
    };
  },
};

const httpImageProviderAdapters: HttpImageProviderAdapter[] = [
  bailianWanxAdapter,
  minimaxAdapter,
  volcSeedreamAdapter,
  openAiImagesAdapter,
  sdWebUiAdapter,
  ollamaAdapter,
  rawAutoAdapter,
];

async function buildImageHttpRequestViaAdapter(ctx: {
  mode: HttpImageMode;
  endpoint: string;
  config: NonNullable<ModelConfig['imageGeneratorConfig']>;
  headers: Record<string, string>;
  params: ImageGenerationParams;
}): Promise<BuiltImageHttpRequest> {
  const request = buildUnifiedImageRequest(ctx.params);
  const adapter = httpImageProviderAdapters.find((a) =>
    a.match({ mode: ctx.mode, endpoint: ctx.endpoint, config: ctx.config })
  )!;
  const built = await adapter.build({
    endpoint: ctx.endpoint,
    config: ctx.config,
    env: ctx.config.env,
    request,
    headers: ctx.headers,
  });
  return {
    ...built,
    mode: built.mode === 'auto' ? ctx.mode : built.mode,
  };
}

function extractOpenAiCompatibleImageDownloadUrl(data: unknown): string | null {
  const all = extractAllOpenAiCompatibleImageUrls(data);
  return all.length ? all[0]! : null;
}

/** 方舟 / OpenAI Images：返回 JSON 或流式 NDJSON/SSE，可能含多张图 URL（data[].url 等） */
function extractAllOpenAiCompatibleImageUrls(data: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string | undefined | null) => {
    const t = String(u ?? '').trim();
    if (!/^https?:\/\//i.test(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  function walkDeep(val: unknown, depth: number, seenObjs: WeakSet<object>): void {
    if (depth > 26 || val === null || val === undefined) return;
    if (typeof val === 'string') {
      const t = val.trim();
      if (
        /^https?:\/\//i.test(t) &&
        (/\bvolces\.com\b/i.test(t) ||
          /\bvolcengine\b/i.test(t) ||
          /\btos-/.test(t) ||
          /\.(png|jpe?g|webp)(\?|$)/i.test(t))
      ) {
        add(t);
      }
      return;
    }
    if (typeof val !== 'object') return;
    if (seenObjs.has(val as object)) return;
    seenObjs.add(val as object);

    if (Array.isArray(val)) {
      for (const x of val) walkDeep(x, depth + 1, seenObjs);
      return;
    }
    const o = val as Record<string, unknown>;
    if (Array.isArray(o.data)) {
      for (const item of o.data) {
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).url === 'string') {
          add((item as Record<string, unknown>).url as string);
        }
      }
    }
    for (const v of Object.values(o)) walkDeep(v, depth + 1, seenObjs);
  }

  walkDeep(data, 0, new WeakSet<object>());
  return out;
}

function collectImageUrlsFromArkStreamOrPlainJson(rawUtf8: string): string[] {
  const merged = stripUtf8Bom(rawUtf8).trim();
  if (!merged) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const pushAll = (j: unknown) => {
    for (const u of extractAllOpenAiCompatibleImageUrls(j)) {
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
  };

  for (const line of merged.split(/\r?\n/)) {
    let t = line.trim();
    if (!t) continue;
    if (t.startsWith('data:')) {
      t = t.slice(5).trim();
    }
    if (t === '[DONE]') continue;
    if (!t.startsWith('{')) continue;
    try {
      pushAll(JSON.parse(t) as unknown);
    } catch {
      /* NDJSON 行可能截断 */
    }
  }

  try {
    pushAll(JSON.parse(merged) as unknown);
  } catch {
    /* 非整块 JSON */
  }

  return out;
}

async function readResponseBodyAsUtf8Streaming(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    let acc = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) acc += dec.decode(value, { stream: true });
    }
    acc += dec.decode();
    return acc;
  } finally {
    reader.releaseLock();
  }
}

async function writePngBuffersToOutputFiles(
  buffersWithBinaries: Buffer[],
  outputDir: string,
  params: ImageGenerationParams
): Promise<Array<{ url: string; path: string; width: number; height: number }>> {
  const results: Array<{ url: string; path: string; width: number; height: number }> = [];
  for (const imageBuf of buffersWithBinaries) {
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    await fs.writeFile(outputPath, imageBuf, { encoding: null });
    let w = Number(params.width) || 512;
    let h = Number(params.height) || 512;
    try {
      const sharp = require('sharp');
      const m = await sharp(outputPath).metadata();
      if (Number.isInteger(m.width) && m.width && m.width > 0) w = m.width;
      if (Number.isInteger(m.height) && m.height && m.height > 0) h = m.height;
    } catch {
      /* no sharp */
    }
    results.push({ url: `file://${outputPath}`, path: outputPath, width: w, height: h });
  }
  return results;
}

async function finalizeOnePngBuffer(
  imageBuf: Buffer,
  outputDir: string,
  params: ImageGenerationParams
): Promise<{ url: string; path: string; width: number; height: number }> {
  const [one] = await writePngBuffersToOutputFiles([imageBuf], outputDir, params);
  return one;
}

async function fetchImageBinaryFromUrl(imageUrl: string, timeoutMs: number): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      throw new Error(
        `拉取图片链接 HTTP ${res.status}；若为火山返回的过期 URL，请缩短生图链路或开大 MYAGENT_IMAGE_GEN_TIMEOUT_MS`
      );
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ollama/兼容端可能返回：整块 JSON、NDJSON、或 text/event-stream 风格 `data: {...}` 行。
 * Content-Type 有时非 application/json，不能依赖 headers。
 */
function extractImageFromOllamaFriendlyBody(buf: Buffer): Buffer | null {
  if (looksLikeBinaryImage(buf)) return buf;

  let raw = stripUtf8Bom(buf.toString('utf8')).trim();
  if (!raw) return null;

  const linesAll = raw.split(/\r?\n/);

  const tryDoc = (data: unknown): Buffer | null => {
    return (
      extractImageBufferFromJson(data, 'ollama') ??
      extractImageBufferFromJson(data, 'sdwebui')
    );
  };

  const sseLike = linesAll.some((l) => l.trim().startsWith('data:'));
  if (sseLike) {
    const payloads: string[] = [];
    for (const line of linesAll) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      payloads.push(p);
    }
    for (let i = payloads.length - 1; i >= 0; i--) {
      try {
        const got = tryDoc(JSON.parse(payloads[i]) as unknown);
        if (got) return got;
      } catch {
        /* ignore */
      }
    }
  }

  if (raw.startsWith('{')) {
    try {
      const got = tryDoc(JSON.parse(raw) as unknown);
      if (got) return got;
    } catch {
      /* NDJSON 或尾随数据 */
    }
  }

  const jsonLines = linesAll.filter((l) => l.trim().startsWith('{'));
  for (let i = jsonLines.length - 1; i >= 0; i--) {
    try {
      const got = tryDoc(JSON.parse(jsonLines[i].trim()) as unknown);
      if (got) return got;
    } catch {
      /* ignore */
    }
  }

  return null;
}

function formatAxiosGenerateHttpError(
  endpoint: string,
  status: number,
  bodyBuf: ArrayBuffer | Buffer | Uint8Array,
  providerHint?: string
): string {
  const raw = (Buffer.isBuffer(bodyBuf)
    ? bodyBuf
    : Buffer.from(bodyBuf instanceof ArrayBuffer ? new Uint8Array(bodyBuf) : bodyBuf)
  )
    .toString('utf8')
    .slice(0, 1400)
    .trim();
  if (!raw) {
    /** 无响应体：按厂商给出针对性排查提示，避免一律显示 Ollama 模板 */
    if (providerHint) {
      return `请求 ${endpoint} 返回 HTTP ${status}（无响应体）。${providerHint}`;
    }
    return `请求 ${endpoint} 返回 HTTP ${status}（无响应体）；请核对 OLLAMA_MODEL、接口是否为 /api/generate，并将 Ollama 升级到支持生图的版本`;
  }
  try {
    const j = JSON.parse(raw) as { error?: unknown; code?: unknown; message?: unknown; request_id?: unknown };
    /** 百炼/DashScope 错误格式：{ code, message, request_id } */
    if (typeof j.code === 'string' && typeof j.message === 'string') {
      const rid = typeof j.request_id === 'string' ? `（request_id: ${j.request_id}）` : '';
      return `HTTP ${status} [${j.code}]：${j.message}${rid}`;
    }
    if (typeof j.error === 'string') return `HTTP ${status}：${j.error}`;
    if (j.error !== undefined && j.error !== null) {
      return `HTTP ${status}：${JSON.stringify(j.error).slice(0, 800)}`;
    }
    /** 有 message 但无 code/error（部分网关） */
    if (typeof j.message === 'string') return `HTTP ${status}：${j.message}`;
  } catch {
    /* 非 JSON */
  }
  return `HTTP ${status}：${raw.slice(0, 900)}`;
}

/** 百炼/万相 404 等常见错误的排查提示 */
function bailianHttpErrorHint(endpoint: string): string {
  const full = 'dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  if (/\/api\/v1\/?$/.test(endpoint) && !endpoint.includes('services')) {
    return `接口地址不完整：wan2.6 同步调用需要完整路径 \`${full}\`，请在「高级」中补全 endpoint。`;
  }
  if (/image-synthesis/i.test(endpoint)) {
    return `当前用的是旧版异步接口 image-synthesis（返回 task_id，需轮询）。wan2.6 同步请改用 \`${full}\`。`;
  }
  return `请核对接口地址是否为 \`/services/aigc/multimodal-generation/generation\`、模型名是否为 \`wan2.6-t2i\`、API Key 是否为有效的 DashScope Key。`;
}

type CliGeneratedImage = { url: string; path: string; width: number; height: number };
type GeneratedImage = { url: string; path: string; width: number; height: number };
type ImageGeneratedCallback = (image: GeneratedImage, index: number, total: number) => void;

/**
 * 单次 CLI 调用：仅校验 `outputPath` 这一张图。
 * 多图场景由上层按 `count` 顺序多次调用（每次独立输出路径、MYAGENT_COUNT=1），
 * 兼容「只往 MYAGENT_OUTPUT_PATH 写一张」的本地脚本。
 */
async function generateImageCliOneShot(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  outputPath: string,
  batch?: { index: number; total: number }
): Promise<CliGeneratedImage> {
  const exe = config.command?.trim();
  if (!exe) {
    throw new Error('请填写「命令行程序」路径');
  }

  const appModule = await import('electron');
  const electronApp = appModule.app;

  const runCount = params.count ?? 1;
  const envVars: Record<string, string> = {
    ...(config.env || {}),
    MYAGENT_PROMPT: params.prompt ?? '',
    MYAGENT_OUTPUT_PATH: outputPath,
    MYAGENT_WIDTH: String(params.width ?? 512),
    MYAGENT_HEIGHT: String(params.height ?? 512),
    MYAGENT_COUNT: String(runCount),
    MYAGENT_REFERENCE_IMAGES: JSON.stringify(params.referenceImages ?? []),
    MYAGENT_SD_ISOLATED_PROMPT: params.isolatedPrompt ? '1' : '0',
  };
  if (batch && batch.total > 1) {
    envVars.MYAGENT_IMAGE_INDEX = String(batch.index);
    envVars.MYAGENT_IMAGE_TOTAL = String(batch.total);
  }

  const rawLines = (config.cliArgLines || '').split('\n');
  const argv = rawLines
    .map((line) => applyCliPlaceholders(line.trim(), params, outputPath))
    .filter((line) => line.length > 0);

  console.info('[生图 CLI] 启动', {
    command: exe,
    argv,
    isolatedPrompt: Boolean(params.isolatedPrompt),
    promptPreview: String(params.prompt ?? '').slice(0, 500),
    width: params.width ?? 512,
    height: params.height ?? 512,
    count: runCount,
    model: envVars.MYAGENT_SD_MODEL,
    outputPath,
    ...(batch && batch.total > 1
      ? { batchIndex: batch.index, batchTotal: batch.total }
      : {}),
  });

  const useShell = process.platform === 'win32' && looksLikeWindowsExec(exe);

  const proc = spawn(exe, argv, {
    env: { ...process.env, ...envVars },
    cwd: electronApp.getPath('home'),
    shell: useShell,
  });

  return await new Promise<CliGeneratedImage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      const min = Math.max(1, Math.round(IMAGE_GEN_TIMEOUT_MS / 60_000));
      reject(new Error(`生图命令超时（${min} 分钟）`));
    }, IMAGE_GEN_TIMEOUT_MS);

    let output = '';
    proc.stdout?.on('data', (data) => {
      output = appendCappedCliLog(output, data);
    });
    proc.stderr?.on('data', (data) => {
      output = appendCappedCliLog(output, data);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      void (async () => {
        try {
          await fs.access(outputPath);
        } catch {
          reject(
            new Error(
              `未在预期路径生成图片文件：${outputPath}\n子进程退出码=${code}\n输出：\n${output.slice(0, 4000)}`
            )
          );
          return;
        }

        if (code !== 0) {
          console.warn('[生图 CLI] 进程退出码非 0，但输出文件已存在:', code);
        }

        let stats: Promise<{ width: number; height: number }>;
        try {
          const sharp = require('sharp');
          stats = sharp(outputPath)
            .metadata()
            .then((m: { width?: number; height?: number }) => ({
              width: m.width ?? NaN,
              height: m.height ?? NaN,
            }));
        } catch {
          stats = Promise.resolve({ width: NaN, height: NaN });
        }

        stats
          .then(({ width, height }) =>
          resolve({
            url: `file://${outputPath}`,
            path: outputPath,
              width:
                Number.isInteger(width) && width > 0 ? width : Number(params.width) || 512,
              height:
                Number.isInteger(height) && height > 0 ? height : Number(params.height) || 512,
            })
          )
          .catch(() =>
          resolve({
            url: `file://${outputPath}`,
            path: outputPath,
              width: Number(params.width) || 512,
              height: Number(params.height) || 512,
            })
          );
      })();
          });
        });
}

async function generateImageCli(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  onImage?: ImageGeneratedCallback
): Promise<GeneratedImage[]> {
  const appModule = await import('electron');
  const electronApp = appModule.app;

  const outputDir =
    params.outputDir ||
    join(electronApp.getPath('documents'), 'MyAgent', 'GeneratedImages');

  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

  if (!config.command?.trim()) {
    throw new Error('请填写「命令行程序」路径');
  }

  const rawN = params.count;
  const requested =
    typeof rawN === 'number' && Number.isFinite(rawN) && rawN > 0 ? Math.round(rawN) : 1;
  const n = Math.max(1, Math.min(12, requested));

  const results: CliGeneratedImage[] = [];
  if (n <= 1) {
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    const img = await generateImageCliOneShot(params, config, outputPath);
    results.push(img);
    onImage?.(img, 1, 1);
    return results;
  }

  for (let i = 0; i < n; i++) {
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    const perParams: ImageGenerationParams = { ...params, count: 1 };
    const img = await generateImageCliOneShot(perParams, config, outputPath, {
      index: i + 1,
      total: n,
    });
    results.push(img);
    onImage?.(img, i + 1, n);
  }
  return results;
}

function detectHttpFormat(
  endpoint: string,
  explicit?: ModelConfig['imageGeneratorConfig']
): 'sdwebui' | 'ollama' | 'raw' | 'openai_images' | 'auto' {
  const ex = explicit?.httpFormat;
  if (ex && ex !== 'auto') return ex;
  const u = endpoint.toLowerCase();
  if (/\/images\/generations/i.test(endpoint)) return 'openai_images';
  if (u.includes('sdapi/v1/txt2img') || u.includes('txt2img')) return 'sdwebui';
  /** Ollama 生图 POST /api/generate；须在 openai_images 之后才判断路径 */
  if (u.includes('/api/generate')) return 'ollama';
  return 'auto';
}

function buildSiblingEndpoint(endpoint: string, pathname: string): string | null {
  try {
    const u = new NodeURL(endpoint);
    u.pathname = pathname;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchOllamaVersion(endpoint: string): Promise<string | null> {
  const versionEndpoint = buildSiblingEndpoint(endpoint, '/api/version');
  if (!versionEndpoint) return null;
  try {
    const res = await fetch(versionEndpoint, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

async function tryOllamaOpenAiImagesFallback(
  endpoint: string,
  model: string,
  params: ImageGenerationParams,
  extraHeaders?: Record<string, string>
): Promise<{ image: Buffer | null; detail: string }> {
  const imagesEndpoint = buildSiblingEndpoint(endpoint, '/v1/images/generations');
  if (!imagesEndpoint) return { image: null, detail: '无法构造 /v1/images/generations 地址' };

  const size =
    typeof params.width === 'number' &&
    params.width > 0 &&
    typeof params.height === 'number' &&
    params.height > 0
      ? `${params.width}x${params.height}`
      : undefined;
  const imagesPayload = JSON.stringify({
    model,
    prompt: params.prompt ?? '',
    ...(size ? { size } : {}),
    response_format: 'b64_json',
  });

  try {
    const raw = await nodeRawPostJsonBody(imagesEndpoint, imagesPayload, OLLAMA_EMPTY_PROBE_MS, extraHeaders);
    if (raw.statusCode < 200 || raw.statusCode >= 300) {
      return {
        image: null,
        detail: formatAxiosGenerateHttpError(imagesEndpoint, raw.statusCode, raw.body),
      };
    }
    const image = extractImageFromOllamaFriendlyBody(raw.body);
    const ct = String(raw.headers['content-type'] ?? '').toLowerCase();
    return {
      image,
      detail: `HTTP ${raw.statusCode}; ${ct || 'unknown content-type'}; ${raw.body.length} bytes`,
    };
  } catch (e) {
    return {
      image: null,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function summarizeOllamaProgressOnlyBody(buf: Buffer): string | null {
  const raw = stripUtf8Bom(buf.toString('utf8')).trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  if (!lines.length) return null;
  let sawProgress = false;
  let sawDoneTrue = false;
  let lastCompleted: unknown;
  let lastTotal: unknown;
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if ('completed' in j || 'total' in j) sawProgress = true;
      if (j.done === true) sawDoneTrue = true;
      if ('completed' in j) lastCompleted = j.completed;
      if ('total' in j) lastTotal = j.total;
      if (typeof j.image === 'string' || typeof j.response === 'string' && j.response.length > 64) {
        return null;
      }
    } catch {
      return null;
    }
  }
  if (!sawProgress || sawDoneTrue) return null;
  const tail =
    lastCompleted !== undefined || lastTotal !== undefined
      ? `最后进度 ${String(lastCompleted ?? '?')}/${String(lastTotal ?? '?')}`
      : `${lines.length} 行进度`;
  return `Ollama 只返回了生成进度（${tail}），没有返回最终 done:true + image 字段`;
}

async function generateImageHttp(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>
): Promise<Array<{ url: string; path: string; width: number; height: number }>> {
  if (!config.endpoint?.trim()) {
    throw new Error('请配置生图 HTTP 接口 URL');
  }

  const appModule = await import('electron');
  const electronApp = appModule.app;

  const outputDir =
    params.outputDir ||
    join(electronApp.getPath('documents'), 'MyAgent', 'GeneratedImages');
  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

  const configuredEndpoint = config.endpoint.trim();
  const mode = detectHttpFormat(configuredEndpoint, config);
  const customHdr = mergedCustomHeadersForImageHttp(config.env, config);
  const authMeta = describeImageHttpAuth(config, config.env, customHdr);

  /** Node 兜底请求也需鉴权头等（远端 OpenAI Images 同理） */
  const mergedFetchHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
    Accept: 'application/json, application/x-ndjson, text/event-stream, image/png, image/*, */*',
    ...customHdr,
  };

  const builtReq = await buildImageHttpRequestViaAdapter({
    mode,
    endpoint: configuredEndpoint,
    config,
    headers: mergedFetchHeaders,
    params,
  });
  const postBody = builtReq.body;
  const providerKind = builtReq.provider;
  let requestUrl = (builtReq.endpoint || configuredEndpoint).trim();
  const ollamaModel = builtReq.ollamaModel || config.env?.OLLAMA_MODEL || config.env?.ollama_model || 'flux';
  const volcOpenAi = Boolean(builtReq.volcOpenAi);
  const readBodyAsStreamingText = Boolean(builtReq.readBodyAsStreamingText);

  if (providerKind === 'minimax') {
    console.warn('[生图 HTTP] MiniMax 请求', {
      url: requestUrl.slice(0, 220),
      authSource: authMeta.source,
      keyHint: authMeta.keyHint || undefined,
    });
  }

  /**
   * 「fetch + 读完 body」共用同一 AbortSignal 与时间预算：不可在仅收到头部后清掉定时器，
   * 否则 Undici 在 body 挂起时会无限 await，主进程 IPC 卡死、整个应用无响应。
   */
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), IMAGE_GEN_TIMEOUT_MS);

  let response: Response;
  let buf: Buffer;

  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: mergedFetchHeaders,
      body: JSON.stringify(postBody),
      signal: abortCtrl.signal,
    });
    if (readBodyAsStreamingText) {
      buf = Buffer.from(await readResponseBodyAsUtf8Streaming(response), 'utf8');
    } else {
      buf = Buffer.from(await response.arrayBuffer());
    }
  } catch (e: unknown) {
    const nm = e instanceof Error ? e.name : '';
    const msg = e instanceof Error ? e.message : String(e);
    if (nm === 'AbortError') {
      throw new Error(
        `生图请求超时（>${Math.round(IMAGE_GEN_TIMEOUT_MS / 60_000)} 分钟）；可用环境变量 MYAGENT_IMAGE_GEN_TIMEOUT_MS（毫秒）调大限时`
      );
    }
    throw new Error(`生图 HTTP 请求失败（含读取响应体）：${msg}`);
  } finally {
    clearTimeout(abortTimer);
  }

  /** MiniMax 2049 常见于国内/国际站与 Key 不匹配：自动换站重试一次 */
  if (providerKind === 'minimax' && buf.length && response.ok) {
    try {
      const peeked = JSON.parse(stripUtf8Bom(buf.toString('utf8'))) as unknown;
      if (peekMiniMaxStatusCode(peeked) === 2049) {
        const alt = alternateMiniMaxImageEndpoint(requestUrl);
        if (alt && alt !== requestUrl) {
          console.warn('[生图 HTTP] MiniMax status_code=2049，尝试另一站点', {
            from: requestUrl.slice(0, 220),
            to: alt.slice(0, 220),
            authSource: authMeta.source,
          });
          const retryCtrl = new AbortController();
          const retryTimer = setTimeout(() => retryCtrl.abort(), IMAGE_GEN_TIMEOUT_MS);
          try {
            const retryRes = await fetch(alt, {
              method: 'POST',
              headers: mergedFetchHeaders,
              body: JSON.stringify(postBody),
              signal: retryCtrl.signal,
            });
            const retryBuf = Buffer.from(await retryRes.arrayBuffer());
            if (retryRes.ok && retryBuf.length) {
              let retryOk = false;
              try {
                const retryJson = JSON.parse(stripUtf8Bom(retryBuf.toString('utf8'))) as unknown;
                const retryCode = peekMiniMaxStatusCode(retryJson);
                retryOk = retryCode === null || retryCode === 0;
              } catch {
                retryOk = false;
              }
              if (retryOk) {
                response = retryRes;
                buf = retryBuf;
                requestUrl = alt;
              }
            }
          } finally {
            clearTimeout(retryTimer);
          }
        }
      }
    } catch {
      /* 非 JSON 或解析失败则走原解析路径 */
    }
  }

  let httpStatus = response.status;
  let ct = String(response.headers.get('content-type') ?? '').toLowerCase();
  let clHdr = response.headers.get('content-length');
  const teHdr = response.headers.get('transfer-encoding');
  let lastEmptyDiagEndpoint = requestUrl;
  /** 后续兜底/解析统一用实际请求 URL（可能已换站） */
  const endpoint = requestUrl;

  if (!response.ok) {
    /** 按厂商给出针对性排查提示，避免一律显示 Ollama 模板 */
    let hint: string | undefined;
    if (providerKind === 'bailian-wanx') hint = bailianHttpErrorHint(endpoint);
    throw new Error(formatAxiosGenerateHttpError(endpoint, httpStatus, buf, hint));
  }

  const bodyPayload = JSON.stringify(postBody);

  if (!buf.length && response.ok) {
    console.warn('[生图 HTTP] fetch 读到 0 字节，尝试 Node http/https 兜底', {
      te: teHdr,
      cl: clHdr,
      endpoint: endpoint.slice(0, 220),
    });
    try {
      const raw = await nodeRawPostJsonBody(endpoint, bodyPayload, IMAGE_GEN_FALLBACK_MS, customHdr);
      if (raw.body.length > 0) {
        buf = raw.body;
        httpStatus = raw.statusCode;
        const hCl = raw.headers['content-length'];
        clHdr = Array.isArray(hCl) ? hCl[0] ?? null : hCl ?? null;
        ct = String(raw.headers['content-type'] ?? '').toLowerCase();
      } else if (raw.statusCode < 200 || raw.statusCode >= 300) {
        throw new Error(formatAxiosGenerateHttpError(endpoint, raw.statusCode, raw.body));
      }
    } catch (e: unknown) {
      console.warn('[生图 HTTP] Node 兜底未完成或失败:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * 部分 Ollama 生图在 stream:false 时对 /api/generate 返回 HTTP 200 + Content-Length:0，
   * 流式下才输出 NDJSON 片段（最后一行常带 image）。
   */
  if (!buf.length && mode === 'ollama' && httpStatus >= 200 && httpStatus < 300) {
    console.warn('[生图 HTTP] 仍为 0 字节；改用 stream:true 再请求一次', {
      model: ollamaModel,
      endpoint: endpoint.slice(0, 220),
    });
    try {
      const streamPayload = JSON.stringify({
        ...postBody,
        stream: true,
      });
      const raw = await nodeRawPostJsonBody(endpoint, streamPayload, OLLAMA_EMPTY_PROBE_MS, customHdr);
      if (raw.body.length > 0 && raw.statusCode >= 200 && raw.statusCode < 300) {
        buf = raw.body;
        httpStatus = raw.statusCode;
        const hCl = raw.headers['content-length'];
        clHdr = Array.isArray(hCl) ? hCl[0] ?? null : hCl ?? null;
        ct = String(raw.headers['content-type'] ?? '').toLowerCase();
      } else if (raw.statusCode < 200 || raw.statusCode >= 300) {
        throw new Error(formatAxiosGenerateHttpError(endpoint, raw.statusCode, raw.body));
      }
    } catch (e: unknown) {
      console.warn('[生图 HTTP] stream:true 兜底失败:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Ollama 的实验生图模型在部分版本上对 /api/generate 直接返回空 body；
   * 新版/兼容层可能只在 OpenAI Images 路径返回 b64_json，因此再试一次同 host 的兼容端点。
   */
  if (!buf.length && mode === 'ollama' && httpStatus >= 200 && httpStatus < 300) {
    const imagesEndpoint = buildSiblingEndpoint(endpoint, '/v1/images/generations');
    if (imagesEndpoint) {
      console.warn('[生图 HTTP] 仍为 0 字节；改用 /v1/images/generations 再请求一次', {
        model: ollamaModel,
        endpoint: imagesEndpoint.slice(0, 220),
      });
      const size =
        typeof params.width === 'number' &&
        params.width > 0 &&
        typeof params.height === 'number' &&
        params.height > 0
          ? `${params.width}x${params.height}`
          : undefined;
      const imagesPayload = JSON.stringify({
        model: ollamaModel,
        prompt: params.prompt ?? '',
        ...(size ? { size } : {}),
        response_format: 'b64_json',
      });
      try {
        const raw = await nodeRawPostJsonBody(
          imagesEndpoint,
          imagesPayload,
          OLLAMA_EMPTY_PROBE_MS,
          customHdr
        );
        lastEmptyDiagEndpoint = imagesEndpoint;
        if (raw.body.length > 0 && raw.statusCode >= 200 && raw.statusCode < 300) {
          buf = raw.body;
          httpStatus = raw.statusCode;
          const hCl = raw.headers['content-length'];
          clHdr = Array.isArray(hCl) ? hCl[0] ?? null : hCl ?? null;
          ct = String(raw.headers['content-type'] ?? '').toLowerCase();
        } else if (raw.statusCode < 200 || raw.statusCode >= 300) {
          throw new Error(formatAxiosGenerateHttpError(imagesEndpoint, raw.statusCode, raw.body));
        }
      } catch (e: unknown) {
        console.warn(
          '[生图 HTTP] /v1/images/generations 兜底失败:',
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  if (!buf.length) {
    if (mode === 'openai_images') {
      throw new Error(
        `OpenAI Images 远端返回空响应体（HTTP ${httpStatus}）。请检查 URL、REMOTE_IMAGE_MODEL、以及火山鉴权 \`ARK_API_KEY\` 或 \`HEADER_AUTHORIZATION\`；若为豆包远端，请参考官方示例使用 \`/images/generations\` 且 \`IMAGE_RESPONSE_FORMAT=url\`。`
      );
    }
    const ollamaVersion = mode === 'ollama' ? await fetchOllamaVersion(endpoint) : null;
    const diag = [
      `HTTP ${httpStatus}`,
      teHdr ? `Transfer-Encoding=${teHdr}` : undefined,
      clHdr != null ? `声明 Content-Length=${clHdr}` : '无 Content-Length',
      ct ? ct : '',
      ollamaVersion ? `Ollama server=${ollamaVersion}` : undefined,
    ]
      .filter(Boolean)
      .join('；');
    console.warn('[生图 HTTP] 仍为 0 字节', {
      diag,
      endpoint: lastEmptyDiagEndpoint.slice(0, 220),
      model: mode === 'ollama' ? ollamaModel : undefined,
    });
    const modelHint =
      mode === 'ollama'
        ? `本次请求解析到的模型字段为「${ollamaModel}」；若在设置里未填 OLLAMA_MODEL，默认为 flux，必须与 \`ollama list\` 里实际存在的**出图**模型完全一致（不要把 VL 闲聊模型当成生图模型）。`
        : '';
    throw new Error(
      `生图接口响应体仍为 0 字节（${diag}）。${modelHint}` +
        `已在应用中依次尝试 /api/generate stream:false、Node 重读、stream:true（NDJSON），以及 /v1/images/generations。` +
        `这说明当前 Ollama 服务端没有通过 HTTP 返回图片数据；请升级 Ollama 服务端到支持实验生图 HTTP 返回的版本，` +
        `并确认设置里的 OLLAMA_MODEL 与 ollama list 完全一致。示例：` +
        `{"model":"x/flux2-klein:4b","prompt":"a cat","stream":false}`
    );
  }

  const utf8Full = stripUtf8Bom(buf.toString('utf8'));
  if (!utf8Full.trim() && !looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    throw new Error(
      '生图接口响应体仅含空白或不可显示的 UTF‑8（无有效 JSON）。请检查 HTTP 接口地址是否为直连 Ollama/生图中间层，并重试。'
    );
  }

  let imageBuf: Buffer | null = null;

  /** 火山豆包：url 模式 + 流式 NDJSON 可能一次返回多张图链接 */
  const preferUrlDownload =
    mode === 'openai_images' &&
    (volcOpenAi || String(postBody.response_format ?? '').toLowerCase() === 'url');

  if (preferUrlDownload && !looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    const urlsFromBody = collectImageUrlsFromArkStreamOrPlainJson(utf8Full);
    if (urlsFromBody.length > 0) {
      const buffers: Buffer[] = [];
      for (const u of urlsFromBody) {
        buffers.push(await fetchImageBinaryFromUrl(u, IMAGE_GEN_TIMEOUT_MS));
      }
      return writePngBuffersToOutputFiles(buffers, outputDir, params);
    }
  }

  /**
   * 百炼/万相同步协议：响应 JSON 为 { output: { results: [{ url | b64_image }] } }。
   * URL 需下载为二进制；b64_image 直接解码。支持多张。
   */
  if (providerKind === 'bailian-wanx' && !looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    let bailianJson: unknown = null;
    try {
      bailianJson = JSON.parse(utf8Full) as unknown;
    } catch {
      /* fallthrough */
    }
    if (bailianJson) {
      const { urls, b64s } = extractImagesFromBailianResponse(bailianJson);
      if (urls.length > 0) {
        const buffers: Buffer[] = [];
        for (const u of urls) {
          buffers.push(await fetchImageBinaryFromUrl(u, IMAGE_GEN_TIMEOUT_MS));
        }
        return writePngBuffersToOutputFiles(buffers, outputDir, params);
      }
      if (b64s.length > 0) {
        const buffers: Buffer[] = [];
        for (const b of b64s) {
          const buf2 = base64FieldToImageBuffer(b);
          if (buf2) buffers.push(buf2);
        }
        if (buffers.length > 0) {
          return writePngBuffersToOutputFiles(buffers, outputDir, params);
        }
      }
    }
  }

  /**
   * MiniMax 响应：{ data: { image_urls | image_base64 }, base_resp }
   * 失败时常仅有 base_resp（HTTP 仍可能 200），必须先读 status_code。
   * 按 provider 或响应形态识别，避免自配 Endpoint/custom 时漏解析。
   */
  if (!looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    let mmJson: unknown = null;
    try {
      mmJson = JSON.parse(utf8Full) as unknown;
    } catch {
      /* fallthrough */
    }
    if (
      mmJson &&
      (providerKind === 'minimax' || looksLikeMiniMaxResponseJson(mmJson))
    ) {
      let mmHost = '';
      try {
        mmHost = new URL(endpoint).host;
      } catch {
        mmHost = endpoint.slice(0, 80);
      }
      const mmMeta = {
        host: mmHost,
        authSource: authMeta.source,
        keyHint: authMeta.keyHint,
      };
      const { urls: mmUrls, b64s: mmB64s } = extractImagesFromMiniMaxResponse(mmJson, mmMeta);
      if (mmUrls.length > 0) {
        const buffers: Buffer[] = [];
        for (const u of mmUrls) {
          buffers.push(await fetchImageBinaryFromUrl(u, IMAGE_GEN_TIMEOUT_MS));
        }
        return writePngBuffersToOutputFiles(buffers, outputDir, params);
      }
      if (mmB64s.length > 0) {
        const buffers: Buffer[] = [];
        for (const b of mmB64s) {
          const buf2 = base64FieldToImageBuffer(b);
          if (buf2) buffers.push(buf2);
        }
        if (buffers.length > 0) {
          return writePngBuffersToOutputFiles(buffers, outputDir, params);
        }
      }
      throw new Error(
        'MiniMax 返回成功状态，但未包含 image_urls / image_base64。请确认模型为 image-01，且 Endpoint 指向 /v1/image_generation。'
      );
    }
  }

  /** 二进制图优先（任何 mode） */
  if (looksLikeBinaryImage(buf)) {
    imageBuf = buf;
  } else if (ct.startsWith('image/')) {
    imageBuf = buf;
  } else if (mode === 'raw') {
    /** 服务端仍可能返回 JSON / SSE — 再走下方解析 */
  }

  if (!imageBuf && (mode === 'sdwebui' || mode === 'ollama' || mode === 'openai_images')) {
    const jsonExtractMode =
      mode === 'openai_images' ? ('auto' as const) : (mode === 'sdwebui' ? ('sdwebui' as const) : ('ollama' as const));
    try {
      const json = JSON.parse(stripUtf8Bom(buf.toString('utf8'))) as unknown;
      imageBuf = extractImageBufferFromJson(json, jsonExtractMode);
      if (!imageBuf && mode === 'openai_images') {
        const href = extractOpenAiCompatibleImageDownloadUrl(json);
        if (href) {
          imageBuf = await fetchImageBinaryFromUrl(href, IMAGE_GEN_TIMEOUT_MS);
        }
      }
    } catch {
      /* fallthrough */
    }
    if (!imageBuf) {
      imageBuf = extractImageFromOllamaFriendlyBody(buf);
    }
  }

  if (!imageBuf && mode === 'auto') {
    if (ct.includes('json') || (buf.length > 2 && buf[0] === 0x7b)) {
      try {
        const json = JSON.parse(stripUtf8Bom(buf.toString('utf8'))) as unknown;
        imageBuf =
          extractImageBufferFromJson(json, 'sdwebui') ||
          extractImageBufferFromJson(json, 'ollama');
      } catch {
        /* ignore */
      }
    }
    /** 不显式标注 JSON 或非标准 Content-Type（仍可能是 Ollama 单包 / NDJSON / SSE） */
    if (!imageBuf) {
      imageBuf = extractImageFromOllamaFriendlyBody(buf);
    }
  }

  /** 用户误选「格式」或未识别 mode 时的最后尝试 */
  if (!imageBuf) {
    imageBuf = extractImageFromOllamaFriendlyBody(buf);
  }

  if (!imageBuf && mode === 'ollama') {
    console.warn('[生图 HTTP] /api/generate 未返回图片；改用 /v1/images/generations 再请求一次', {
      model: ollamaModel,
      endpoint: endpoint.slice(0, 220),
      bytes: buf.length,
    });
    const viaImages = await tryOllamaOpenAiImagesFallback(endpoint, ollamaModel, params, customHdr);
    if (viaImages.image) {
      imageBuf = viaImages.image;
    } else {
      console.warn('[生图 HTTP] /v1/images/generations 未返回图片', {
        detail: viaImages.detail,
      });
    }
  }

  if (!imageBuf) {
    let topKeys = '';
    try {
      const j = JSON.parse(utf8Full.trim()) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        topKeys = Object.keys(j as Record<string, unknown>)
          .slice(0, 24)
          .join(', ');
      }
    } catch {
      /* 非整块 JSON */
    }
    console.warn('[生图 HTTP] 无法解析', {
      contentType: ct,
      bytes: buf.length,
      utf8Preview: utf8Full.slice(0, 220).replace(/\s+/g, ' '),
      hexHead32: buf.subarray(0, 32).toString('hex'),
      jsonTopKeys: topKeys || undefined,
    });
    const hintKeys = topKeys ? `（已解析 JSON 顶级键：${topKeys}，其中未识别出图片字段）` : '';
    const progressOnlyHint =
      mode === 'ollama' ? summarizeOllamaProgressOnlyBody(buf) : null;
    throw new Error(
      `无法从 HTTP 响应解析图片${hintKeys}。${progressOnlyHint ? progressOnlyHint + '。' : ''}` +
        `若为 Ollama：当前服务端必须在 /api/generate 或 /v1/images/generations 返回 image/base64；` +
        `如果只返回 completed/total 进度，请升级并重启 Ollama 服务端，确认 server 版本与客户端一致。`
    );
  }

  return [await finalizeOnePngBuffer(imageBuf, outputDir, params)];
}

function isUsableImageConfig(
  c: ModelConfig['imageGeneratorConfig'] | undefined
): c is NonNullable<ModelConfig['imageGeneratorConfig']> {
  if (!c) return false;
  if (c.type === 'http') return Boolean(c.endpoint && String(c.endpoint).trim());
  return Boolean(c.command && String(c.command).trim());
}

ipcMain.handle('generate-image', (event, params: ImageGenerationParams) =>
  enqueueSerializedImageGeneration(() => invokeGenerateImageIpc(params, (image, index, total) => {
    if (!params.streamRequestId) return;
    event.sender.send('image-generation-image', {
      requestId: params.streamRequestId,
      image,
      index,
      total,
    });
  }))
);

async function invokeGenerateImageIpc(params: ImageGenerationParams, onImage?: ImageGeneratedCallback) {
  const config = params.imageGeneratorConfig;
  if (!isUsableImageConfig(config)) {
    throw new Error(
      '未配置图像生成工具：请在设置中添加模型并勾选「生图工具」，填写 CLI 或 HTTP；保存后重试。'
    );
  }

  try {
    if (config.type === 'http') {
      /** HTTP 多张补齐：各厂商单次请求有上限（百炼4、火山~15、OpenAI10、SDWebUI8、Ollama/raw1），
       *  当期望张数超过单次返回时，串行循环补齐，使最终总数尽量接近用户期望。 */
      const desiredCount =
        typeof params.count === 'number' && params.count > 0 ? Math.max(1, params.count) : 1;
      const collected: GeneratedImage[] = [];
      /** 安全上限：防止异常死循环 */
      const maxRounds = Math.min(12, Math.ceil(desiredCount / 1));
      for (let round = 0; round < maxRounds && collected.length < desiredCount; round++) {
        const remaining = desiredCount - collected.length;
        const roundParams: ImageGenerationParams = {
          ...params,
          count: remaining,
        };
        const imgs = await generateImageHttp(roundParams, config);
        if (imgs.length === 0) break; // 厂商没返回，继续也没意义
        for (const img of imgs) {
          collected.push(img);
          onImage?.(img, collected.length, desiredCount);
        }
        /** 厂商单次就满足了，或本轮没进展（返回数<=0），停止避免空转 */
        if (imgs.length >= remaining) break;
      }
      return collected;
    }
    return await generateImageCli(params, config, onImage);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error('生图失败: ' + msg);
  }
}
