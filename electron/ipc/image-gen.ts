import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { URL as NodeURL } from 'node:url';
import { type ModelConfig, ImageGenerationParams } from '../../src/types';

/** CLI 子进程 stdout/stderr 合并上限，避免海量日志撑爆主进程内存导致假死 */
const MAX_CLI_COMBINED_LOG_CHARS = 200_000;

function appendCappedCliLog(acc: string, chunk: Buffer | string): string {
  if (acc.length >= MAX_CLI_COMBINED_LOG_CHARS) return acc;
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const room = MAX_CLI_COMBINED_LOG_CHARS - acc.length;
  return acc + (s.length <= room ? s : `${s.slice(0, room)}\n…[CLI 输出已截断]\n`);
}

/**
 * 生图环境变量中 `HEADER_<名称>` 形如 `HEADER_AUTHORIZATION=Bearer xxx` → HTTP 请求头 `Authorization`.
 * （名称段按分段首字母大写并 `-` 连接，如 HEADER_X_API_KEY→X-Api-Key）
 */
function normalizeBearerAuthorization(headerValue: string): string {
  const t = headerValue.trim();
  if (!t) return t;
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

function hasExplicitAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
}

function bearerFromBareApiKeysInEnv(env: Record<string, string> | undefined): string | undefined {
  if (!env) return undefined;
  const ordered = ['ARK_API_KEY', 'VOLC_ENGINE_API_KEY', 'VOLCES_API_KEY', 'VOLC_IMAGE_API_KEY'];
  for (const k of ordered) {
    const raw = typeof env[k] === 'string' ? env[k].trim() : '';
    if (raw) return normalizeBearerAuthorization(raw);
  }
  return undefined;
}

function mergedCustomHeadersForImageHttp(env: Record<string, string> | undefined): Record<string, string> {
  const merged = extraHttpHeadersFromImageEnv(env);
  if (!hasExplicitAuthorizationHeader(merged)) {
    const b = bearerFromBareApiKeysInEnv(env);
    if (b) merged.Authorization = b;
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
  const p = params.prompt ?? '';
  return line
    .replace(/\{\{prompt\}\}/g, p)
    .replace(/\{\{outputPath\}\}/g, outputPath)
    .replace(/\{\{width\}\}/g, w)
    .replace(/\{\{height\}\}/g, h);
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

function arkVolcDoubaoCompatibleRequestBody(
  env: Record<string, string> | undefined,
  model: string,
  params: ImageGenerationParams
): Record<string, unknown> {
  const imgEarly = parseArkImageFieldFromEnv(env);

  const explicitSeqRaw = (
    env?.SEQUENTIAL_IMAGE_GENERATION ||
    env?.ARK_SEQUENTIAL_IMAGE_GENERATION ||
    ''
  ).trim();
  const seqWasExplicit = explicitSeqRaw.length > 0;

  let seq = explicitSeqRaw;
  const maxParsedRaw = env?.ARK_MAX_IMAGES ?? env?.MAX_IMAGES ?? '';
  const maxParsed = parseInt(String(maxParsedRaw), 10);

  const multiRefs = Array.isArray(imgEarly) && imgEarly.filter(Boolean).length > 1;
  const wantsMultiOutputs = Number.isFinite(maxParsed) && maxParsed > 1;

  if (!seq) {
    if (wantsMultiOutputs || multiRefs) seq = 'auto';
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
  if ((!seqOptions || Object.keys(seqOptions).length === 0) && Number.isFinite(maxParsed) && maxParsed > 0) {
    seqOptions = { max_images: maxParsed };
  } else if (
    !seqWasExplicit &&
    seq.trim().toLowerCase() === 'auto' &&
    (!seqOptions || Object.keys(seqOptions).length === 0) &&
    String(maxParsedRaw).trim() === ''
  ) {
    /** 仅当服务端未显式要求且由本客户端推断 auto 时补 max_images */
    seqOptions = { max_images: multiRefs ? 4 : 2 };
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
    body.image = imgEarly;
  }

  return body;
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
  bodyBuf: ArrayBuffer | Buffer | Uint8Array
): string {
  const raw = (Buffer.isBuffer(bodyBuf)
    ? bodyBuf
    : Buffer.from(bodyBuf instanceof ArrayBuffer ? new Uint8Array(bodyBuf) : bodyBuf)
  )
    .toString('utf8')
    .slice(0, 1400)
    .trim();
  if (!raw) {
    return `请求 ${endpoint} 返回 HTTP ${status}（无响应体）；请核对 OLLAMA_MODEL、接口是否为 /api/generate，并将 Ollama 升级到支持生图的版本`;
  }
  try {
    const j = JSON.parse(raw) as { error?: unknown };
    if (typeof j.error === 'string') return `HTTP ${status}：${j.error}`;
    if (j.error !== undefined && j.error !== null) {
      return `HTTP ${status}：${JSON.stringify(j.error).slice(0, 800)}`;
    }
  } catch {
    /* 非 JSON */
  }
  return `HTTP ${status}：${raw.slice(0, 900)}`;
}

async function generateImageCli(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>
): Promise<Array<{ url: string; path: string; width: number; height: number }>> {
  const appModule = await import('electron');
  const electronApp = appModule.app;

  const outputDir =
    params.outputDir ||
    join(electronApp.getPath('documents'), 'MyAgent', 'GeneratedImages');

  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

  if (!config.command?.trim()) {
    throw new Error('请填写「命令行程序」路径');
  }

  const outputFile = `${randomUUID()}.png`;
  const outputPath = join(outputDir, outputFile);

  const envVars: Record<string, string> = {
    ...(config.env || {}),
    MYAGENT_PROMPT: params.prompt ?? '',
    MYAGENT_OUTPUT_PATH: outputPath,
    MYAGENT_WIDTH: String(params.width ?? 512),
    MYAGENT_HEIGHT: String(params.height ?? 512),
  };

  const rawLines = (config.cliArgLines || '').split('\n');
  const argv = rawLines
    .map((line) => applyCliPlaceholders(line.trim(), params, outputPath))
    .filter((line) => line.length > 0);


  const useShell = process.platform === 'win32' && looksLikeWindowsExec(config.command);

  const proc = spawn(config.command, argv, {
    env: { ...process.env, ...envVars },
    cwd: electronApp.getPath('home'),
    shell: useShell,
  });

  const result = await new Promise<{ url: string; path: string; width: number; height: number }>(
    (resolve, reject) => {
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
    }
  );

  return [result];
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

  const endpoint = config.endpoint.trim();
  const mode = detectHttpFormat(endpoint, config);
  const ollamaModel =
    config.env?.OLLAMA_MODEL || config.env?.ollama_model || 'flux';
  const customHdr = mergedCustomHeadersForImageHttp(config.env);

  /** Node 兜底请求也需鉴权头等（远端 OpenAI Images 同理） */
  const mergedFetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, application/x-ndjson, text/event-stream, image/png, image/*, */*',
    ...customHdr,
  };

  let postBody: Record<string, unknown>;
  if (mode === 'openai_images') {
    const modelEnv =
      config.env?.REMOTE_IMAGE_MODEL ||
      config.env?.IMAGE_MODEL ||
      config.env?.ARK_IMAGE_MODEL ||
      config.env?.DOUBAO_IMAGE_MODEL ||
      '';
    const model =
      typeof modelEnv === 'string' ? modelEnv.trim() : String(modelEnv ?? '').trim();
    if (!model) {
      throw new Error(
        'OpenAI Images 请在环境变量中填写模型名：`REMOTE_IMAGE_MODEL` 或 `IMAGE_MODEL`（例：doubao-seedream-4-5-251128）；火山接入点仍为 ep-xxx 时也填在此。鉴权：`ARK_API_KEY=…`（与官方 curl）或 `HEADER_AUTHORIZATION=Bearer …`。'
      );
    }

    const volcArk = isVolcArkImageGenerationsEndpoint(endpoint);
    if (volcArk) {
      if (!hasExplicitAuthorizationHeader(mergedFetchHeaders)) {
        throw new Error(
          '火山方舟返回 401 多为鉴权未带上：请在生图模型「环境变量」中填写 `ARK_API_KEY=你的密钥`（等价于 curl 的 Bearer），或填写 `HEADER_AUTHORIZATION=Bearer 你的密钥`；不要使用对话模型的 Key 占位。'
        );
      }
      postBody = arkVolcDoubaoCompatibleRequestBody(config.env, model, params);
    } else {
      const rf =
        (config.env?.IMAGE_RESPONSE_FORMAT || config.env?.RESPONSE_FORMAT || '').trim() || 'b64_json';
      let sz =
        typeof params.width === 'number' &&
        params.width > 0 &&
        typeof params.height === 'number' &&
        params.height > 0
          ? `${Math.round(params.width)}x${Math.round(params.height)}`
          : '1024x1024';
      const forcedSize = (config.env?.ARK_SIZE || config.env?.IMAGE_SIZE || '').trim();
      if (forcedSize) sz = forcedSize;
      postBody = {
        model,
        prompt: params.prompt ?? '',
        size: sz,
        response_format: rf === 'url' ? 'url' : 'b64_json',
      };
    }
  } else if (mode === 'sdwebui') {
    postBody = {
      prompt: params.prompt,
      negative_prompt: '',
      steps: 25,
      width: params.width || 512,
      height: params.height || 512,
      cfg_scale: 7,
      sampler_index: 'Euler a',
      n_iter: 1,
      batch_size: 1,
    };
  } else if (mode === 'ollama') {
    postBody = {
      model: ollamaModel,
      prompt: params.prompt ?? '',
      stream: false,
    };
    /** 可选；仅生图模型会消费（见 Ollama 文档 experimental image generation） */
    if (typeof params.width === 'number' && params.width > 0) postBody.width = params.width;
    if (typeof params.height === 'number' && params.height > 0) postBody.height = params.height;
  } else {
    postBody = {
      prompt: params.prompt,
      width: params.width,
      height: params.height,
    };
  }

  const volcOpenAi = mode === 'openai_images' && isVolcArkImageGenerationsEndpoint(endpoint);
  const readBodyAsStreamingText = volcOpenAi && Boolean(postBody.stream);

  /**
   * 「fetch + 读完 body」共用同一 AbortSignal 与时间预算：不可在仅收到头部后清掉定时器，
   * 否则 Undici 在 body 挂起时会无限 await，主进程 IPC 卡死、整个应用无响应。
   */
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), IMAGE_GEN_TIMEOUT_MS);

  let response: Response;
  let buf: Buffer;

  try {
    response = await fetch(endpoint, {
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

  let httpStatus = response.status;
  let ct = String(response.headers.get('content-type') ?? '').toLowerCase();
  let clHdr = response.headers.get('content-length');
  const teHdr = response.headers.get('transfer-encoding');
  let lastEmptyDiagEndpoint = endpoint;

  if (!response.ok) {
    throw new Error(formatAxiosGenerateHttpError(endpoint, httpStatus, buf));
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

ipcMain.handle('generate-image', (_event, params: ImageGenerationParams) =>
  enqueueSerializedImageGeneration(() => invokeGenerateImageIpc(params))
);

async function invokeGenerateImageIpc(params: ImageGenerationParams) {
  const config = params.imageGeneratorConfig;
  if (!isUsableImageConfig(config)) {
    throw new Error(
      '未配置图像生成工具：请在设置中添加模型并勾选「生图工具」，填写 CLI 或 HTTP；保存后重试。'
    );
  }

  try {
    if (config.type === 'http') {
      return await generateImageHttp(params, config);
    }
    return await generateImageCli(params, config);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error('生图失败: ' + msg);
  }
}

