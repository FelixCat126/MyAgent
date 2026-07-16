import { base64FieldToImageBuffer, stripUtf8Bom } from './parsing';

const MAX_JSON_IMAGE_SCAN_DEPTH = 14; // 仍保留旧声明以兼容，逐函数改完后删除

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

export {
  extractImageBufferFromJson,
  extractImageDeepScan,
  extractOpenAiCompatibleImageDownloadUrl,
  extractAllOpenAiCompatibleImageUrls,
  collectImageUrlsFromArkStreamOrPlainJson,
  readResponseBodyAsUtf8Streaming,
};
