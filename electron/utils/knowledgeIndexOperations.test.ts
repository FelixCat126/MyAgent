// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/** 该模块顶层会 import electron（through vectorIndexPersistence），node 环境下需 stub */
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/myagent-test-userdata' },
}));

import {
  buildFingerprintsForChunkPaths,
  cantIncrementalReuse,
  type KnowledgeEmbedPayload,
} from './knowledgeIndexOperations';
import type { WorkspaceIndexedFileMeta } from './workspaceIndex';
import type {
  VectorIndexFileV1,
  VectorFileFingerprintV1,
} from './vectorIndexPersistence';

function meta(rel: string, mtimeMs: number, size: number): WorkspaceIndexedFileMeta {
  return {
    absolutePath: `/root/${rel}`,
    relPosix: rel,
    mtimeMs,
    size,
  };
}

function fp(mtimeMs: number, size: number): VectorFileFingerprintV1 {
  return { mtimeMs, size };
}

function makeIndex(overrides: Partial<VectorIndexFileV1>): VectorIndexFileV1 {
  return {
    v: 1,
    root: '/root',
    provider: 'openai',
    model: 'text-embedding-3-small',
    updatedAt: 0,
    dim: 768,
    chunks: [{ id: 'a.md#0', path: 'a.md', text: 't', emb: [1, 2] }],
    fingerprints: { 'a.md': fp(10, 100) },
    ...overrides,
  };
}

describe('buildFingerprintsForChunkPaths', () => {
  it('仅为给定路径输出指纹，忽略磁盘上多余文件', () => {
    const diskByRel = new Map([
      ['a.md', meta('a.md', 1, 10)],
      ['b.md', meta('b.md', 2, 20)],
      ['c.md', meta('c.md', 3, 30)],
    ]);
    const out = buildFingerprintsForChunkPaths(['a.md', 'b.md'], diskByRel);
    expect(out).toEqual({
      'a.md': { mtimeMs: 1, size: 10 },
      'b.md': { mtimeMs: 2, size: 20 },
    });
  });

  it('Windows 风格路径会归一化为 /', () => {
    const diskByRel = new Map([['sub/x.md', meta('sub/x.md', 9, 88)]]);
    const out = buildFingerprintsForChunkPaths(['sub\\x.md'], diskByRel);
    expect(out['sub/x.md']).toEqual({ mtimeMs: 9, size: 88 });
  });

  it('磁盘缺失的路径会被忽略', () => {
    const diskByRel = new Map([['a.md', meta('a.md', 1, 10)]]);
    const out = buildFingerprintsForChunkPaths(['a.md', 'gone.md'], diskByRel);
    expect(out).toEqual({ 'a.md': { mtimeMs: 1, size: 10 } });
  });

  it('重复路径只产出一次指纹', () => {
    const diskByRel = new Map([['a.md', meta('a.md', 1, 10)]]);
    const out = buildFingerprintsForChunkPaths(['a.md', 'a.md', 'a.md'], diskByRel);
    expect(Object.keys(out)).toEqual(['a.md']);
  });
});

describe('cantIncrementalReuse', () => {
  const baseEmbed: KnowledgeEmbedPayload = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'k',
    model: 'text-embedding-3-small',
  };
  const rootAbs = '/root';

  it('无旧索引或空 chunks → 不能复用', () => {
    expect(cantIncrementalReuse(null, rootAbs, baseEmbed)).toBe(true);
    expect(cantIncrementalReuse(makeIndex({ chunks: [] }), rootAbs, baseEmbed)).toBe(true);
  });

  it('根目录不一致 → 不能复用', () => {
    expect(cantIncrementalReuse(makeIndex({ root: '/elsewhere' }), rootAbs, baseEmbed)).toBe(true);
  });

  it('provider 或 model 不同 → 不能复用', () => {
    expect(cantIncrementalReuse(makeIndex({ provider: 'ollama' }), rootAbs, baseEmbed)).toBe(true);
    expect(cantIncrementalReuse(makeIndex({ model: 'other' }), rootAbs, baseEmbed)).toBe(true);
  });

  it('dim 缺失或指纹为空 → 不能复用', () => {
    expect(cantIncrementalReuse(makeIndex({ dim: 0 }), rootAbs, baseEmbed)).toBe(true);
    expect(cantIncrementalReuse(makeIndex({ fingerprints: {} }), rootAbs, baseEmbed)).toBe(true);
    expect(cantIncrementalReuse(makeIndex({ fingerprints: undefined }), rootAbs, baseEmbed)).toBe(true);
  });

  it('全部一致 → 可复用', () => {
    expect(cantIncrementalReuse(makeIndex({}), rootAbs, baseEmbed)).toBe(false);
  });
});
