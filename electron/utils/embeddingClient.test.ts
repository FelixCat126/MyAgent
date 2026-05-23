// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => {
  const post = vi.fn();
  return {
    default: { post },
    post,
  };
});

import axios from 'axios';
import {
  fetchEmbeddingsBatched,
  fetchEmbeddingsOllama,
  fetchEmbeddingsOpenAI,
  fetchQueryEmbedding,
} from './embeddingClient';

const postMock = (axios as unknown as { post: ReturnType<typeof vi.fn> }).post;

function vec(seed: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, i) => seed + i / 10);
}

function openAiResponse(vectors: number[][]) {
  return {
    status: 200,
    data: {
      data: vectors.map((emb, i) => ({ embedding: emb, index: i })),
    },
  };
}

describe('fetchEmbeddingsOpenAI', () => {
  beforeEach(() => postMock.mockReset());

  it('使用 …/v1/embeddings 路径并带 Bearer Token', async () => {
    postMock.mockResolvedValueOnce(openAiResponse([vec(0.1), vec(0.2)]));
    const out = await fetchEmbeddingsOpenAI(['a', 'b'], {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-xyz',
      model: 'text-embedding-3-small',
    });
    expect(out).toHaveLength(2);
    expect(postMock).toHaveBeenCalledOnce();
    const [url, body, cfg] = postMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(body).toMatchObject({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    expect(cfg.headers.Authorization).toBe('Bearer sk-xyz');
  });

  it('方舟 …/api/v3 不再补 /v1，直接拼 /embeddings', async () => {
    postMock.mockResolvedValueOnce(openAiResponse([vec(0.5)]));
    await fetchEmbeddingsOpenAI(['hi'], {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'k',
      model: 'doubao-embedding-text',
    });
    expect(postMock.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings');
  });

  it('非 2xx 时抛出带 status 与提示的错误', async () => {
    postMock.mockResolvedValueOnce({ status: 404, data: '{"error":"missing"}' });
    await expect(
      fetchEmbeddingsOpenAI(['x'], { baseUrl: 'https://x.test/v1', model: 'm' })
    ).rejects.toThrow(/HTTP 404/);
  });

  it('data.error 提示直接抛错', async () => {
    postMock.mockResolvedValueOnce({
      status: 200,
      data: { error: { message: 'rate limited' } },
    });
    await expect(
      fetchEmbeddingsOpenAI(['x'], { baseUrl: 'https://x.test/v1', model: 'm' })
    ).rejects.toThrow(/rate limited/);
  });
});

describe('fetchEmbeddingsOllama', () => {
  beforeEach(() => postMock.mockReset());

  it('为每条 input 单独发请求，且使用 /api/embeddings', async () => {
    postMock.mockResolvedValue({ data: { embedding: vec(0.1) } });
    const out = await fetchEmbeddingsOllama(['a', 'b'], {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
    });
    expect(out).toHaveLength(2);
    expect(postMock).toHaveBeenCalledTimes(2);
    for (const c of postMock.mock.calls) {
      expect(c[0]).toBe('http://127.0.0.1:11434/api/embeddings');
    }
  });

  it('缺少 embedding 数组时抛错', async () => {
    postMock.mockResolvedValue({ data: {} });
    await expect(
      fetchEmbeddingsOllama(['x'], { baseUrl: 'http://127.0.0.1:11434', model: 'm' })
    ).rejects.toThrow(/缺少 embedding/);
  });
});

describe('fetchEmbeddingsBatched', () => {
  beforeEach(() => postMock.mockReset());
  afterEach(() => vi.useRealTimers());

  it('空输入直接返回 []', async () => {
    const out = await fetchEmbeddingsBatched([], {
      provider: 'openai',
      baseUrl: 'https://x.test/v1',
      model: 'm',
    });
    expect(out).toEqual([]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('OpenAI 路径按 10 条一批拆分', async () => {
    const inputs = Array.from({ length: 25 }, (_, i) => `t${i}`);
    postMock
      .mockResolvedValueOnce(openAiResponse(Array.from({ length: 10 }, (_v, i) => vec(i))))
      .mockResolvedValueOnce(openAiResponse(Array.from({ length: 10 }, (_v, i) => vec(10 + i))))
      .mockResolvedValueOnce(openAiResponse(Array.from({ length: 5 }, (_v, i) => vec(20 + i))));
    const out = await fetchEmbeddingsBatched(inputs, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'm',
    });
    expect(out).toHaveLength(25);
    expect(postMock).toHaveBeenCalledTimes(3);
    const inputsPerCall = postMock.mock.calls.map(
      (c) => (c[1] as { input: unknown[] }).input.length
    );
    expect(inputsPerCall).toEqual([10, 10, 5]);
  });

  it('ollama provider 走单条循环', async () => {
    postMock.mockResolvedValue({ data: { embedding: vec(1) } });
    const out = await fetchEmbeddingsBatched(['a', 'b'], {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'm',
    });
    expect(out).toHaveLength(2);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('volcMultimodal 路径走 /embeddings/multimodal 且 input 包成 {type, text}', async () => {
    postMock.mockResolvedValue(openAiResponse([vec(0.7)]));
    const out = await fetchEmbeddingsBatched(['hi'], {
      provider: 'openai',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'k',
      model: 'doubao-embedding-vision',
      volcMultimodal: true,
    });
    expect(out).toHaveLength(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal');
    expect(body).toMatchObject({ input: [{ type: 'text', text: 'hi' }] });
  });
});

describe('fetchQueryEmbedding', () => {
  beforeEach(() => postMock.mockReset());

  it('返回首个向量', async () => {
    postMock.mockResolvedValueOnce(openAiResponse([vec(0.42, 6)]));
    const v = await fetchQueryEmbedding('查询', {
      provider: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
    });
    expect(v).toHaveLength(6);
  });
});
