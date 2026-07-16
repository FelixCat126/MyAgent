import { extname } from 'path';
import fs from 'fs/promises';
import { ImageGenerationParams } from '../../../src/types';

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
    console.warn('[生图 HTTP] 参考图读取失败，已跳过:', typeof s === 'string' ? s.split(/[\\/]/).pop() : '', e instanceof Error ? e.message : e);
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

export {
  isVolcArkImageGenerationsEndpoint,
  parseEnvBoolFlexible,
  parseArkImageFieldFromEnv,
  normalizeReferenceImageForApi,
  normalizeReferenceImagesForApi,
  inferVolcArkDoubaoSizeFromParams,
  inferArkStreamFlag,
  arkVolcDoubaoCompatibleRequestBody,
  imageMimeFromPath,
};
