// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => {
  const post = vi.fn();
  return { default: { post }, post };
});

import axios from 'axios';
import { fetchEmbeddingsOllama, fetchEmbeddingsOpenAI } from './embeddingClient';

const postMock = (axios as unknown as { post: ReturnType<typeof vi.fn> }).post;

describe('embedding endpoint resolution', () => {
  beforeEach(() => postMock.mockReset());

  it.each([
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/embeddings'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3/embeddings'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/embeddings'],
    ['https://example.com', 'https://example.com/v1/embeddings'],
  ])('%s → %s', async (baseUrl, expected) => {
    postMock.mockResolvedValueOnce({ status: 200, data: { data: [{ embedding: [1, 0], index: 0 }] } });
    await fetchEmbeddingsOpenAI(['x'], { baseUrl, model: 'embedding-3' });
    expect(postMock.mock.calls[0][0]).toBe(expected);
  });

  it('strips an OpenAI-compatible /v1 suffix from Ollama service URLs', async () => {
    postMock.mockResolvedValueOnce({ data: { embedding: [1, 0] } });
    await fetchEmbeddingsOllama(['x'], { baseUrl: 'http://127.0.0.1:11434/v1/', model: 'nomic-embed-text' });
    expect(postMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/embeddings');
  });
});
