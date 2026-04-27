import { describe, expect, it } from 'vitest';
import { normalizeEmbeddingOpenAiBaseUrl } from './embeddingNormalize';

describe('normalizeEmbeddingOpenAiBaseUrl', () => {
  it('strips chat completions suffix', () => {
    expect(normalizeEmbeddingOpenAiBaseUrl('https://api.x.com/v1/chat/completions')).toBe(
      'https://api.x.com'
    );
  });

  it('keeps bare v1', () => {
    expect(normalizeEmbeddingOpenAiBaseUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1'
    );
  });

  it('strips embeddings path', () => {
    expect(normalizeEmbeddingOpenAiBaseUrl('https://x.com/v1/embeddings')).toBe('https://x.com');
  });

  it('rewrites Volc Ark coding root to api/v3 for embeddings', () => {
    expect(
      normalizeEmbeddingOpenAiBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3')
    ).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });
});
