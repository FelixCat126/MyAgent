import { ImageGenerationParams } from '../../../../src/types';
import { hasExplicitAuthorizationHeader, effectiveImageProvider } from '../auth';
import type { HttpImageProviderAdapter } from './types';

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

export {
  minimaxAdapter,
  extractImagesFromMiniMaxResponse,
  inferMiniMaxAspectRatio,
  looksLikeMiniMaxResponseJson,
  formatMiniMaxStatusError,
  assertMiniMaxBaseRespOk,
  peekMiniMaxStatusCode,
  normalizeMiniMaxImageEndpoint,
  alternateMiniMaxImageEndpoint,
};
