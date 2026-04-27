/**
 * 在「与问题最像」的若干分块中，按相关度与相邻落差动态决定条数（0 … topK），避免固定打满 K。
 * 常数在经验范围内可调，均基于余弦相似度 ∈ [0,1]（无意义匹配常低于 0.15）。
 */
export const RAG_RELEVANCE = {
  /** 最相关分块仍低于此值则整体不附片段 */
  minBest: 0.16,
  /** 后续分块允许的最低分（且须不低于 best×relFloor） */
  minEach: 0.1,
  /** 相邻两档分块分相差过大时不再追加（elbow） */
  maxGap: 0.12,
  /** 与最佳分块的最小相对比（过弱不凑数） */
  relFloor: 0.5,
} as const;

export function selectChunkIndicesByRelevance(
  sortedDesc: { i: number; s: number }[],
  topK: number
): number[] {
  if (topK <= 0 || sortedDesc.length === 0) return [];
  const s0 = sortedDesc[0]!.s;
  if (s0 < RAG_RELEVANCE.minBest) return [];

  const out: number[] = [sortedDesc[0]!.i];
  for (let j = 1; j < sortedDesc.length && out.length < topK; j++) {
    const prev = sortedDesc[j - 1]!;
    const cur = sortedDesc[j]!;
    if (prev.s - cur.s > RAG_RELEVANCE.maxGap) break;
    if (cur.s < RAG_RELEVANCE.minEach) break;
    if (cur.s < s0 * RAG_RELEVANCE.relFloor) break;
    out.push(cur.i);
  }
  return out;
}
