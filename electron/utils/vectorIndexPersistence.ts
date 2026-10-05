import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { expandUserPath } from './expandUserPath';
import { realpathSync } from 'node:fs';
import { rankByCosine } from '../../src/utils/vectorMath';
import { selectChunkIndicesByRelevance } from '../../src/utils/ragRelevance';
import { fetchQueryEmbedding, type EmbeddingProviderKey } from './embeddingClient';

export type VectorChunkV1 = {
  id: string;
  path: string;
  text: string;
  emb: number[];
};

/** 单文件指纹：用于增量建索引，避免整库反复全文读取与重嵌入 */
export type VectorFileFingerprintV1 = { mtimeMs: number; size: number };

export type VectorIndexFileV1 = {
  v: 1;
  root: string;
  provider: EmbeddingProviderKey;
  model: string;
  baseUrl?: string;
  volcMultimodal?: boolean;
  updatedAt: number;
  dim: number;
  chunks: VectorChunkV1[];
  /** 相对工作区路径（POSIX）→ 指纹；旧索引无此字段时首次「增量」会退化为全文重建 */
  fingerprints?: Record<string, VectorFileFingerprintV1>;
};

function knowledgeDir(): string {
  return path.join(app.getPath('userData'), 'knowledge');
}

function normalizedIndexRoot(root: string): string {
  const absolute = path.resolve(expandUserPath(root));
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function vectorIndexFilePath(root?: string): string {
  if (!root) return path.join(knowledgeDir(), 'vector-index-v1.json');
  const normalized = normalizedIndexRoot(root);
  const hash = createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex');
  return path.join(knowledgeDir(), `vector-index-${hash}.json`);
}

async function readIndexFile(p: string): Promise<VectorIndexFileV1 | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw) as VectorIndexFileV1;
    if (!j || j.v !== 1 || typeof j.root !== 'string' || !j.root.trim() || !Array.isArray(j.chunks)) return null;
    if ((j.provider !== 'openai' && j.provider !== 'ollama') || typeof j.model !== 'string' || !j.model.trim() || !Number.isFinite(j.updatedAt) || !Number.isInteger(j.dim) || j.dim < 0) return null;
    if (j.chunks.length && !j.dim) return null;
    if (j.chunks.some((chunk) => !chunk || typeof chunk.id !== 'string' || typeof chunk.path !== 'string' || typeof chunk.text !== 'string' || !Array.isArray(chunk.emb) || chunk.emb.length !== j.dim || chunk.emb.some((n) => typeof n !== 'number' || !Number.isFinite(n)))) return null;
    return j;
  } catch {
    return null;
  }
}

/** Root-scoped reads never return another project's index. The old single file migrates only on a matching root. */
export async function readVectorIndex(root?: string): Promise<VectorIndexFileV1 | null> {
  if (root) {
    const current = await readIndexFile(vectorIndexFilePath(root));
    if (current && rootsMatchIndex(current.root, root)) return current;
    const legacy = await readIndexFile(vectorIndexFilePath());
    if (legacy && rootsMatchIndex(legacy.root, root)) { await writeVectorIndex(legacy); return legacy; }
    return null;
  }
  // Preserve the old no-argument status API by reporting the most recently updated index.
  let latest = await readIndexFile(vectorIndexFilePath());
  try {
    for (const name of await fs.readdir(knowledgeDir())) {
      if (!/^vector-index-[a-f0-9]{64}\.json$/.test(name)) continue;
      const candidate = await readIndexFile(path.join(knowledgeDir(), name));
      if (candidate && (!latest || candidate.updatedAt >= latest.updatedAt)) latest = candidate;
    }
  } catch { /* no knowledge directory yet */ }
  return latest;
}

export async function writeVectorIndex(data: VectorIndexFileV1): Promise<void> {
  const dir = knowledgeDir();
  await fs.mkdir(dir, { recursive: true });
  const p = vectorIndexFilePath(data.root);
  const tmp = `${p}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, p);
  } finally { await fs.unlink(tmp).catch(() => {}); }
}

export function rootsMatchIndex(stored: string, current: string): boolean {
  const a = normalizedIndexRoot(stored);
  const b = normalizedIndexRoot(current);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function searchIndex(args: {
  root: string;
  query: string;
  topK: number;
  maxChars: number;
  embed: {
    provider: EmbeddingProviderKey;
    baseUrl: string;
    apiKey?: string;
    model: string;
    volcMultimodal?: boolean;
  };
}): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  meta?: { chunkCount: number; usedChunks: number };
}> {
  if (!args.embed?.provider || !args.embed.baseUrl?.trim() || !args.embed.model?.trim()) return { ok: false, error: '尚未配置有效的嵌入服务。' };
  let root: string;
  let idx: VectorIndexFileV1 | null;
  try {
    if (!args.root?.trim()) return { ok: false, error: '资料目录为空。' };
    root = await fs.realpath(path.resolve(expandUserPath(args.root)));
    // Inspect every file's mtime/size before querying. Changed/deleted text is never served from stale embeddings.
    const { performIncrementalKnowledgeIndex } = await import('./knowledgeIndexOperations');
    const refreshed = await performIncrementalKnowledgeIndex(root, args.embed);
    if (!refreshed.ok) return { ok: false, error: `资料索引更新失败：${refreshed.error}` };
    idx = await readVectorIndex(root);
  } catch (error) { return { ok: false, error: `资料索引不可用：${error instanceof Error ? error.message : String(error)}` }; }
  if (!idx) return { ok: false, error: '当前资料目录没有可用索引。' };
  if (!idx.chunks.length) return { ok: true, text: '', meta: { chunkCount: 0, usedChunks: 0 } };
  const q = String(args.query || '').trim();
  if (!q) {
    return { ok: true, text: '', meta: { chunkCount: idx.chunks.length, usedChunks: 0 } };
  }
  let qv: number[];
  try {
    qv = await fetchQueryEmbedding(q, {
      provider: args.embed.provider,
      baseUrl: args.embed.baseUrl,
      apiKey: args.embed.apiKey,
      model: args.embed.model,
      volcMultimodal: args.embed.volcMultimodal,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `查询嵌入失败：${m}` };
  }
  if (!Array.isArray(qv) || !qv.length || qv.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return { ok: false, error: '查询嵌入返回了无效向量，请检查嵌入服务。' };
  if (idx.dim > 0 && qv.length !== idx.dim) {
    return { ok: false, error: `查询向量维数 ${qv.length} 与索引维数 ${idx.dim} 不一致，请用同一嵌入模型重新建索引。` };
  }
  const k = Math.max(1, Math.min(20, Math.floor(Number(args.topK) || 5)));
  const maxChars = Math.max(0, Math.min(50_000, Number(args.maxChars) || 8000));
  const embs = idx.chunks.map((c) => c.emb);
  const ranked = rankByCosine(qv, embs);
  const pick = selectChunkIndicesByRelevance(ranked, k);
  const parts: string[] = [];
  let used = 0;
  for (const i of pick) {
    const ch = idx.chunks[i];
    if (!ch) continue;
    const block = `《${ch.path}》\n${ch.text}\n`;
    if (parts.join('\n---\n').length + block.length + (parts.length ? '\n---\n'.length : 0) > maxChars) break;
    parts.push(block);
    used++;
  }
  return {
    ok: true,
    text: parts.join('\n---\n').trim(),
    meta: { chunkCount: idx.chunks.length, usedChunks: used },
  };
}
