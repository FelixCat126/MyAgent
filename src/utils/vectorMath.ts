export function l2Norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1e-9;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (l2Norm(a) * l2Norm(b));
}

export function topKByCosine(query: number[], embeddings: number[][], k: number): number[] {
  if (k <= 0 || embeddings.length === 0) return [];
  return rankByCosine(query, embeddings)
    .slice(0, k)
    .map((r) => r.i);
}

/** 按与 query 的余弦相似度降序，用于动态截断、相关度门槛 */
export function rankByCosine(
  query: number[],
  embeddings: number[][]
): { i: number; s: number }[] {
  if (embeddings.length === 0) return [];
  const scored: { i: number; s: number }[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    scored.push({ i, s: cosineSimilarity(query, embeddings[i]) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored;
}
