// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ userData: '', failEmbeddings: false }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./embeddingClient', () => ({
  fetchEmbeddingsBatched: vi.fn(async (texts: string[]) => { if (state.failEmbeddings) throw new Error('embedding unavailable'); return texts.map(() => [1, 0]); }),
  fetchQueryEmbedding: vi.fn(async () => [1, 0]),
}));
import { readVectorIndex, searchIndex, vectorIndexFilePath, writeVectorIndex, type VectorIndexFileV1 } from './vectorIndexPersistence';
import { performFullKnowledgeIndex } from './knowledgeIndexOperations';
import { fetchEmbeddingsBatched, fetchQueryEmbedding } from './embeddingClient';

let fixture = '';
let a = '';
let b = '';
const embed = { provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'test-embed' };
const search = (root: string) => searchIndex({ root, query: 'report', topK: 5, maxChars: 8000, embed });
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-vector-test-'));
  state.userData = path.join(fixture, 'userdata');
  state.failEmbeddings = false;
  vi.clearAllMocks();
  a = path.join(fixture, 'a'); b = path.join(fixture, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'report.md'), 'Project A report version one');
  await fs.writeFile(path.join(b, 'report.md'), 'Project B report private details');
});
afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

describe('per-directory vector persistence and automatic freshness', () => {
  it('keeps independent files and never retrieves content from another project', async () => {
    expect((await performFullKnowledgeIndex(a, embed)).ok).toBe(true);
    expect((await performFullKnowledgeIndex(b, embed)).ok).toBe(true);
    expect(vectorIndexFilePath(a)).not.toBe(vectorIndexFilePath(b));
    expect((await readVectorIndex(a))?.chunks[0].text).toContain('Project A');
    expect((await readVectorIndex(b))?.chunks[0].text).toContain('Project B');
    const result = await search(a);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Project A');
    expect(result.text).not.toContain('Project B');
    const before = vi.mocked(fetchEmbeddingsBatched).mock.calls.length;
    const storedBefore = await fs.readFile(vectorIndexFilePath(a), 'utf8');
    await search(a);
    expect(vi.mocked(fetchEmbeddingsBatched).mock.calls.length).toBe(before);
    expect(await fs.readFile(vectorIndexFilePath(a), 'utf8')).toBe(storedBefore);
  });

  it('refreshes changed files before search and removes deleted content from retrieval', async () => {
    await performFullKnowledgeIndex(a, embed);
    await fs.writeFile(path.join(a, 'report.md'), 'Project A revised report with new numbers 987654');
    const result = await search(a);
    expect(result.text).toContain('987654');
    expect(result.text).not.toContain('version one');
    await fs.unlink(path.join(a, 'report.md'));
    expect(await search(a)).toMatchObject({ ok: true, text: '', meta: { chunkCount: 0, usedChunks: 0 } });
    expect((await readVectorIndex(a))?.chunks).toEqual([]);
    expect(await search(a)).toMatchObject({ ok: true, text: '', meta: { chunkCount: 0, usedChunks: 0 } });
    await fs.writeFile(path.join(a, 'new.md'), 'Project A new file after the old source was deleted');
    expect((await search(a)).text).toContain('new file');
  });

  it('reports embedding update failures instead of presenting stale source text as a success', async () => {
    await performFullKnowledgeIndex(a, embed);
    await fs.writeFile(path.join(a, 'report.md'), 'Modified content requiring a new embedding');
    state.failEmbeddings = true;
    const result = await search(a);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('embedding unavailable');
    expect(result.text).toBeUndefined();
    state.failEmbeddings = false;
    expect((await search(a)).text).toContain('Modified content');
  });

  it('migrates only a matching legacy root and rebuilds with a verified embedding identity', async () => {
    const legacy: VectorIndexFileV1 = { v: 1, root: a, provider: 'ollama', model: 'test-embed', updatedAt: 1, dim: 2, chunks: [{ id: 'report.md#0', path: 'report.md', text: 'Legacy A content', emb: [1, 0] }] };
    await fs.mkdir(path.dirname(vectorIndexFilePath()), { recursive: true });
    await fs.writeFile(vectorIndexFilePath(), JSON.stringify(legacy));
    expect(await readVectorIndex(b)).toBeNull();
    expect((await readVectorIndex(a))?.chunks[0].text).toBe('Legacy A content');
    expect((await search(a)).text).toContain('Project A report version one');
    expect((await readVectorIndex(a))?.baseUrl).toBe(embed.baseUrl);
    expect((await fs.stat(vectorIndexFilePath())).isFile()).toBe(true);
  });

  it('supports first-use indexing and serializes simultaneous updates without losing files', async () => {
    const results = await Promise.all([search(a), search(a), search(b)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0].text).toContain('Project A');
    expect(results[2].text).toContain('Project B');
    const persisted = await fs.readdir(path.dirname(vectorIndexFilePath()));
    expect(persisted.filter((name) => /vector-index-[a-f0-9]{64}\.json$/.test(name))).toHaveLength(2);
    expect(persisted.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('returns an explicit error for a missing root or unconfigured embedding and ignores symlink sources', async () => {
    await fs.symlink(path.join(b, 'report.md'), path.join(a, 'outside.md'));
    const result = await search(a);
    expect(result.text).not.toContain('Project B');
    expect((await search(path.join(fixture, 'missing'))).ok).toBe(false);
    expect((await searchIndex({ root: a, query: 'x', topK: 1, maxChars: 1000, embed: { ...embed, model: '' } })).error).toContain('嵌入服务');
    const index = (await readVectorIndex(a))!;
    await writeVectorIndex(index);
    expect((await readVectorIndex())?.root).toBe(await fs.realpath(a));
  });

  it('invalidates former text when an explicit rebuild finds no remaining documents', async () => {
    await performFullKnowledgeIndex(a, embed);
    await fs.unlink(path.join(a, 'report.md'));
    expect((await performFullKnowledgeIndex(a, embed)).ok).toBe(false);
    expect((await readVectorIndex(a))?.chunks).toEqual([]);
    expect((await search(a)).text).toBe('');
  });

  it('rejects malformed persisted dimensions and invalid query vectors', async () => {
    await performFullKnowledgeIndex(a, embed);
    const original = (await readVectorIndex(a))!;
    await fs.writeFile(vectorIndexFilePath(a), JSON.stringify({ ...original, dim: 100 }));
    expect(await readVectorIndex(a)).toBeNull();
    expect((await search(a)).text).toContain('Project A');
    vi.mocked(fetchQueryEmbedding).mockResolvedValueOnce([Number.NaN, 0]);
    expect((await search(a)).error).toContain('无效向量');
    vi.mocked(fetchQueryEmbedding).mockResolvedValueOnce([1]);
    expect((await search(a)).error).toContain('维数');
  });
});
