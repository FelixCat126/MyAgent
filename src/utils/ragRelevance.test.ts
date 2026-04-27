import { describe, expect, it } from 'vitest';
import { selectChunkIndicesByRelevance, RAG_RELEVANCE } from './ragRelevance';

describe('selectChunkIndicesByRelevance', () => {
  it('returns empty when best below minBest', () => {
    expect(
      selectChunkIndicesByRelevance(
        [
          { i: 0, s: RAG_RELEVANCE.minBest - 0.02 },
          { i: 1, s: 0.05 },
        ],
        5
      )
    ).toEqual([]);
  });

  it('keeps first and stops on large gap', () => {
    const r = selectChunkIndicesByRelevance(
      [
        { i: 2, s: 0.5 },
        { i: 0, s: 0.45 },
        { i: 1, s: 0.32 },
      ],
      5
    );
    expect(r).toEqual([2, 0]);
  });

  it('respects topK', () => {
    const list = [0, 1, 2, 3, 4, 5].map((i) => ({ i, s: 0.3 - i * 0.01 }));
    expect(selectChunkIndicesByRelevance(list, 2).length).toBeLessThanOrEqual(2);
  });
});
