import axios from 'axios';
import { parseOpenAiCompatibleEmbeddingResponse } from '../../src/utils/embeddingParse';
import { normalizeEmbeddingOpenAiBaseUrl } from '../../src/utils/embeddingNormalize';

export type EmbeddingProviderKey = 'openai' | 'ollama';

function openAiEmbeddingsUrl(base: string): string {
  const b = base.replace(/\/$/, '');
  // OpenAI 官方：…/v1/embeddings
  if (b.endsWith('/v1')) return `${b}/embeddings`;
  // 火山方舟 / 豆包等：…/api/v3/embeddings（见官网向量化 API，勿再套一层 /v1）
  if (/\/v3$/i.test(b)) return `${b}/embeddings`;
  // 其它兼容：根上已带版本时由用户写全，否则按 OpenAI 习惯补 v1
  return `${b}/v1/embeddings`;
}

/** Doubao-embedding-vision 等：…/api/v3/embeddings/multimodal */
function openAiEmbeddingsUrlVolcMultimodal(base: string): string {
  const b = base.replace(/\/$/, '');
  if (/\/v3$/i.test(b)) return `${b}/embeddings/multimodal`;
  throw new Error('多模态向量化需使用以 …/api/v3 结尾的方舟 Base（如 https://ark.cn-beijing.volces.com/api/v3）');
}

function buildEmbeddingHttpError(
  res: { status: number; data: unknown },
  url: string,
  data: Record<string, unknown> | undefined
): Error {
  const snip =
    typeof data === 'string'
      ? String(data).slice(0, 280)
      : JSON.stringify(data ?? '').slice(0, 280);
  const hint404 =
    res.status === 404
      ? ' 常见原因：①「服务地址」应填到 …/v1，不要填 …/v1/chat/completions；② 该网关若仅提供对话、不提供嵌入，也会 404，请换提供 text-embedding 的服务或使用本机 Ollama 嵌入。'
      : '';
  const hint5xx =
    res.status >= 500
      ? ' 若为火山方舟：嵌入 Base 须为 …/api/v3（不要用 …/api/coding/v3）；模型填控制台「向量化」Endpoint ID。500 也可能是服务端瞬时故障，可稍后重试。'
      : '';
  return new Error(`嵌入 HTTP ${res.status}（请求 ${url}）：${snip || '(空响应)'}${hint404}${hint5xx}`);
}

/**
 * OpenAI/兼容：支持批量 input
 */
export async function fetchEmbeddingsOpenAI(
  inputs: string[],
  opts: { baseUrl: string; apiKey?: string; model: string }
): Promise<number[][]> {
  const base = normalizeEmbeddingOpenAiBaseUrl(opts.baseUrl);
  const url = openAiEmbeddingsUrl(base);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  const res = await axios.post(
    url,
    { model: opts.model, input: inputs, encoding_format: 'float' },
    { headers, timeout: 120_000, validateStatus: (s) => s < 600 }
  );
  const data = res.data as Record<string, unknown> | undefined;
  if (res.status < 200 || res.status >= 300) {
    throw buildEmbeddingHttpError(res, url, data);
  }
  if (data?.error) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : (data.error as { message?: string })?.message || JSON.stringify(data.error)
    );
  }
  return parseOpenAiCompatibleEmbeddingResponse(data, inputs.length);
}

/**
 * 火山豆包 Doubao-embedding-vision：标准 /embeddings 的 input 为字符串数组，多模态接口要求
 * input: [{ type: "text", text: "…" }]，且路径为 /embeddings/multimodal（见官方文档与 Postman 示例）。
 * 每段文本单独请求，保证与分块 1:1 对应。
 */
async function fetchEmbeddingsVolcArkMultimodalText(
  inputs: string[],
  opts: { baseUrl: string; apiKey?: string; model: string }
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const base = normalizeEmbeddingOpenAiBaseUrl(opts.baseUrl);
  const url = openAiEmbeddingsUrlVolcMultimodal(base);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;
  const out: number[][] = [];
  for (const text of inputs) {
    const res = await axios.post(
      url,
      { model: opts.model, input: [{ type: 'text', text }] },
      { headers, timeout: 120_000, validateStatus: (s) => s < 600 }
    );
    const data = res.data as Record<string, unknown> | undefined;
    if (res.status < 200 || res.status >= 300) {
      throw buildEmbeddingHttpError(res, url, data);
    }
    if (data?.error) {
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : (data.error as { message?: string })?.message || JSON.stringify(data.error)
      );
    }
    const part = parseOpenAiCompatibleEmbeddingResponse(data, 1);
    out.push(part[0]);
    await new Promise((r) => setTimeout(r, 15));
  }
  return out;
}

/**
 * Ollama /api/embeddings，一次一个 prompt
 */
export async function fetchEmbeddingsOllama(
  inputs: string[],
  opts: { baseUrl: string; model: string }
): Promise<number[][]> {
  const host = opts.baseUrl.replace(/\/$/, '');
  const url = `${host}/api/embeddings`;
  const out: number[][] = [];
  for (const prompt of inputs) {
    const { data } = await axios.post(
      url,
      { model: opts.model, prompt, stream: false },
      { timeout: 120_000, validateStatus: (s) => s < 500 }
    );
    if (data?.error) {
      throw new Error(
        typeof data.error === 'string' ? data.error : data.error?.message || 'Ollama 嵌入错误'
      );
    }
    const emb = data?.embedding;
    if (!Array.isArray(emb)) throw new Error('Ollama 嵌入返回缺少 embedding 数组');
    out.push(emb);
    await new Promise((r) => setTimeout(r, 20));
  }
  return out;
}

// 方舟等 OpenAI 兼容嵌入常见单批上限为 10 条 input；与 32 会报 InvalidParameter
const BATCH = 10;

export async function fetchEmbeddingsBatched(
  inputs: string[],
  opts: {
    provider: EmbeddingProviderKey;
    baseUrl: string;
    apiKey?: string;
    model: string;
    volcMultimodal?: boolean;
  }
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (opts.provider === 'ollama') {
    return fetchEmbeddingsOllama(inputs, {
      baseUrl: opts.baseUrl,
      model: opts.model,
    });
  }
  if (opts.volcMultimodal) {
    return fetchEmbeddingsVolcArkMultimodalText(inputs, {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
    });
  }
  const all: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const part = await fetchEmbeddingsOpenAI(batch, {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    if (part.length !== batch.length) {
      throw new Error(`OpenAI 嵌入数量不符：期望 ${batch.length} 得到 ${part.length}`);
    }
    all.push(...part);
  }
  return all;
}

export async function fetchQueryEmbedding(
  text: string,
  opts: {
    provider: EmbeddingProviderKey;
    baseUrl: string;
    apiKey?: string;
    model: string;
    volcMultimodal?: boolean;
  }
): Promise<number[]> {
  const [v] = await fetchEmbeddingsBatched([text], opts);
  if (!v?.length) throw new Error('查询向量空');
  return v;
}
