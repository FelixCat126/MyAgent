import { describe, expect, it } from 'vitest';
import { cosineSimilarity, topKByCosine, rankByCosine } from './vectorMath';

describe('vectorMath', () => {
  it('cosine self = 1', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('topKByCosine picks best', () => {
    const q = [1, 0, 0];
    const emb = [
      [0, 1, 0],
      [1, 0, 0],
      [0.99, 0.01, 0],
    ];
    expect(topKByCosine(q, emb, 2)).toEqual([1, 2]);
  });

  it('rankByCosine is sorted by score', () => {
    const q = [1, 0, 0];
    const emb = [
      [0, 1, 0],
      [1, 0, 0],
    ];
    const r = rankByCosine(q, emb);
    expect(r[0]!.i).toBe(1);
    expect(r[0]!.s).toBeGreaterThanOrEqual(r[1]!.s);
  });
});
