import { URL as NodeURL } from 'node:url';
import { ImageGenerationParams } from '../../../src/types';
import { stripUtf8Bom, looksLikeBinaryImage } from './parsing';
import { extractImageBufferFromJson } from './responseParsers';
import { nodeRawPostJsonBody } from './httpClient';
import { formatAxiosGenerateHttpError } from './formatError';
import { OLLAMA_EMPTY_PROBE_MS } from './queue';

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

export {
  buildSiblingEndpoint,
  fetchOllamaVersion,
  tryOllamaOpenAiImagesFallback,
  summarizeOllamaProgressOnlyBody,
  extractImageFromOllamaFriendlyBody,
};
