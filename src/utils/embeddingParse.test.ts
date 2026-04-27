import { describe, expect, it } from 'vitest';
import { parseOpenAiCompatibleEmbeddingResponse } from './embeddingParse';

describe('parseOpenAiCompatibleEmbeddingResponse', () => {
  it('parses OpenAI data array', () => {
    const v = [[0.1, 0.2], [0.3, 0.4]];
    const out = parseOpenAiCompatibleEmbeddingResponse(
      {
        data: [
          { index: 1, embedding: v[1] },
          { index: 0, embedding: v[0] },
        ],
      },
      2
    );
    expect(out).toEqual(v);
  });

  it('parses single top-level embedding', () => {
    const emb = [1, 2, 3];
    const out = parseOpenAiCompatibleEmbeddingResponse({ embedding: emb }, 1);
    expect(out).toEqual([emb]);
  });

  it('parses embeddings matrix', () => {
    const m = [
      [1, 2],
      [3, 4],
    ];
    expect(parseOpenAiCompatibleEmbeddingResponse({ embeddings: m }, 2)).toEqual(m);
  });
});
