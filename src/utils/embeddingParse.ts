/**
 * 解析各家「OpenAI 兼容」嵌入接口的常见 JSON 形态（主进程嵌入客户端使用）
 */
export function parseOpenAiCompatibleEmbeddingResponse(
  data: unknown,
  expectedBatch: number
): number[][] {
  if (data === null || data === undefined) {
    throw new Error('嵌入接口返回体为空');
  }
  if (typeof data === 'string') {
    throw new Error(
      '嵌入接口返回了纯文本/HTML（多为 URL、鉴权或网关错误页面），请检查 baseUrl、API Key 与路径是否为 /v1/embeddings'
    );
  }
  if (typeof data !== 'object') {
    throw new Error(`嵌入响应类型异常：${typeof data}`);
  }

  const d = data as Record<string, unknown>;
  const keys = Object.keys(d);

  // OpenAI 官方：{ data: [ { index, embedding }, ... ] }
  if (Array.isArray(d.data)) {
    const arr = d.data as Array<{ embedding?: number[]; index?: number }>;
    const sorted = [...arr].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: number[][] = [];
    for (let i = 0; i < sorted.length; i++) {
      const emb = sorted[i].embedding;
      if (!Array.isArray(emb)) {
        throw new Error(`嵌入项 ${i} 缺少 embedding 数组`);
      }
      vectors.push(emb as number[]);
    }
    if (vectors.length !== expectedBatch) {
      throw new Error(`嵌入条数不符：请求 ${expectedBatch} 条，响应 ${vectors.length} 条`);
    }
    return vectors;
  }

  // 部分网关单次请求直接返回顶层 embedding
  if (expectedBatch === 1 && Array.isArray(d.embedding)) {
    return [d.embedding as number[]];
  }

  const nestedData = d.data;
  if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
    const emb = (nestedData as { embedding?: unknown }).embedding;
    if (Array.isArray(emb) && expectedBatch === 1) {
      return [emb as number[]];
    }
  }

  // 少数服务：{ embeddings: number[][] }
  if (Array.isArray(d.embeddings)) {
    const emb = d.embeddings as unknown;
    if (Array.isArray(emb) && emb.length > 0 && Array.isArray((emb as unknown[])[0])) {
      const vectors = emb as number[][];
      if (vectors.length !== expectedBatch) {
        throw new Error(`嵌入条数不符：请求 ${expectedBatch} 条，响应 ${vectors.length} 条`);
      }
      return vectors;
    }
  }

  // output.embeddings（部分云厂商封装）
  const output = d.output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (Array.isArray(o.embeddings)) {
      const vectors = o.embeddings as number[][];
      if (vectors.length !== expectedBatch) {
        throw new Error(`嵌入条数不符：请求 ${expectedBatch} 条，响应 ${vectors.length} 条`);
      }
      return vectors;
    }
  }

  throw new Error(
    `无法解析嵌入 JSON（顶层键：${keys.slice(0, 20).join(', ') || '无'}）。请确认接口兼容 OpenAI「POST …/v1/embeddings」且返回含向量数组。`
  );
}
