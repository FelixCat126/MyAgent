import path from 'path';
import { expandUserPath } from './expandUserPath';
import {
  chunksForIndexedFile,
  collectWorkspaceChunks,
  listWorkspaceFilesForIncremental,
  type WorkspaceChunk,
  type WorkspaceIndexedFileMeta,
} from './workspaceIndex';
import { fetchEmbeddingsBatched, type EmbeddingProviderKey } from './embeddingClient';
import {
  readVectorIndex,
  writeVectorIndex,
  rootsMatchIndex,
  type VectorChunkV1,
  type VectorIndexFileV1,
  type VectorFileFingerprintV1,
} from './vectorIndexPersistence';

export type KnowledgeEmbedPayload = {
  provider: EmbeddingProviderKey;
  baseUrl: string;
  apiKey?: string;
  model: string;
  volcMultimodal?: boolean;
};

export type KnowledgeIndexOk = {
  ok: true;
  fileCount: number;
  chunkCount: number;
  truncated: boolean;
  root: string;
  reusedChunks?: number;
  rebuiltFiles?: number;
};

export type KnowledgeIndexErr = {
  ok: false;
  error: string;
};

/** 指纹表：仅存当前仍有向量分块的源文件路径 */
export function buildFingerprintsForChunkPaths(
  chunkPathsRelative: Iterable<string>,
  diskByRel: Map<string, WorkspaceIndexedFileMeta>
): Record<string, VectorFileFingerprintV1> {
  const out: Record<string, VectorFileFingerprintV1> = {};
  const seen = new Set<string>();
  for (const rel of chunkPathsRelative) {
    const k = String(rel || '').replace(/\\/g, '/');
    if (seen.has(k)) continue;
    seen.add(k);
    const meta = diskByRel.get(k);
    if (!meta) continue;
    out[k] = { mtimeMs: meta.mtimeMs, size: meta.size };
  }
  return out;
}

async function embedWorkspaceChunks(chunks: WorkspaceChunk[], embed: KnowledgeEmbedPayload): Promise<VectorChunkV1[]> {
  if (!chunks.length) return [];
  const texts = chunks.map((c) => c.text);
  const vectors = await fetchEmbeddingsBatched(texts, {
    provider: embed.provider,
    baseUrl: embed.baseUrl,
    apiKey: embed.apiKey,
    model: embed.model,
    volcMultimodal: embed.volcMultimodal,
  });
  if (vectors.length !== chunks.length) {
    throw new Error('嵌入条数与分块数不一致');
  }
  const dim = vectors[0]?.length || 0;
  if (!dim) throw new Error('得到空向量');
  return chunks.map((c, i) => ({
    id: c.id,
    path: c.path,
    text: c.text,
    emb: vectors[i],
  }));
}

async function persistFullIndex(params: {
  root: string;
  chunksPlain: WorkspaceChunk[];
  vectors: VectorChunkV1[];
  diskByRel: Map<string, WorkspaceIndexedFileMeta>;
  embed: KnowledgeEmbedPayload;
}) {
  const { root, chunksPlain, vectors, diskByRel, embed } = params;
  const dim = vectors[0]?.emb.length || 0;
  const uniqPaths = new Set<string>(chunksPlain.map((c) => c.path.replace(/\\/g, '/')));
  const fingerprints = buildFingerprintsForChunkPaths(uniqPaths, diskByRel);
  const data: VectorIndexFileV1 = {
    v: 1 as const,
    root,
    provider: embed.provider,
    model: embed.model,
    updatedAt: Date.now(),
    dim,
    chunks: vectors,
    fingerprints,
  };
  await writeVectorIndex(data);
}

export async function performFullKnowledgeIndex(
  rawRoot: string,
  embed: KnowledgeEmbedPayload
): Promise<KnowledgeIndexOk | KnowledgeIndexErr> {
  const resolved = path.resolve(expandUserPath(String(rawRoot || '').trim()));
  const diskMetas = await listWorkspaceFilesForIncremental(resolved);
  const diskByRel = new Map(diskMetas.map((m) => [m.relPosix.replace(/\\/g, '/'), m]));

    const { chunks, fileCount, truncated } = await collectWorkspaceChunks(resolved);
  if (!chunks.length) {
    return {
      ok: false as const,
      error:
        '未发现可索引内容（或超出文件/分块限制）。请确认目录含 .md / .txt / .docx / .xlsx 等。',
    };
  }
  let vectors: VectorChunkV1[];
  try {
    vectors = await embedWorkspaceChunks(chunks, embed);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: `嵌入请求失败：${m}` };
  }
  try {
    await persistFullIndex({
      root: resolved,
      chunksPlain: chunks,
      vectors,
      diskByRel,
      embed,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: `索引写入失败：${m}` };
  }
  return {
    ok: true as const,
    fileCount,
    chunkCount: vectors.length,
    truncated,
    root: resolved,
    reusedChunks: 0,
    rebuiltFiles: fileCount,
  };
}

/** 不满足增量条件时需由调用方改用全文索引 */
export function cantIncrementalReuse(existing: VectorIndexFileV1 | null, rootAbs: string, embed: KnowledgeEmbedPayload): boolean {
  if (!existing || !existing.chunks?.length) return true;
  if (!rootsMatchIndex(existing.root, rootAbs)) return true;
  if (existing.provider !== embed.provider || existing.model !== embed.model) return true;
  if (!existing.dim) return true;
  if (!existing.fingerprints || Object.keys(existing.fingerprints).length === 0) return true;
  return false;
}

export async function performIncrementalKnowledgeIndex(
  rawRoot: string,
  embed: KnowledgeEmbedPayload
): Promise<KnowledgeIndexOk | KnowledgeIndexErr> {
  const resolved = path.resolve(expandUserPath(String(rawRoot || '').trim()));
  const existing = await readVectorIndex();
  if (cantIncrementalReuse(existing, resolved, embed) || !existing) {
    return performFullKnowledgeIndex(rawRoot, embed);
  }

  const MAX_TOTAL = 2500;

  const diskMetas = await listWorkspaceFilesForIncremental(resolved);
  const diskByRel = new Map(diskMetas.map((m) => [m.relPosix.replace(/\\/g, '/'), m]));

  const rebuildPaths = new Set<string>();
  for (const meta of diskMetas) {
    const k = meta.relPosix.replace(/\\/g, '/');
    const fp = existing.fingerprints?.[k];
    if (!fp || fp.mtimeMs !== meta.mtimeMs || fp.size !== meta.size) {
      rebuildPaths.add(k);
    }
  }

  const kept: VectorChunkV1[] = [];
  for (const ch of existing.chunks) {
    const k = ch.path.replace(/\\/g, '/');
    if (!diskByRel.has(k)) continue;
    if (rebuildPaths.has(k)) continue;
    kept.push(ch);
  }

  const globalCount = { n: kept.length };
  let truncated = false;
  const newPlain: WorkspaceChunk[] = [];

  const norm = resolved;
  for (const rel of rebuildPaths) {
    const meta = diskByRel.get(rel);
    if (!meta) continue;
    if (globalCount.n >= MAX_TOTAL) {
      truncated = true;
      break;
    }
    const piece = await chunksForIndexedFile(norm, meta, globalCount);
    newPlain.push(...piece);
    if (globalCount.n >= MAX_TOTAL && piece.length) truncated = true;
  }

  try {
    let newVectors: VectorChunkV1[] = [];
    if (newPlain.length) {
      newVectors = await embedWorkspaceChunks(newPlain, embed);
      if (newVectors.length !== newPlain.length) {
        return { ok: false as const, error: '嵌入条数与分块数不一致' };
      }
      if (
        existing.dim &&
        newVectors[0].emb.length &&
        newVectors[0].emb.length !== existing.dim
      ) {
        return performFullKnowledgeIndex(rawRoot, embed);
      }
    }

    let merged = [...kept, ...newVectors];
    let mergedTruncated = truncated;
    if (merged.length > MAX_TOTAL) {
      mergedTruncated = true;
      merged = merged.slice(0, MAX_TOTAL);
    }

    const uniqPathsFinal = new Set<string>(merged.map((c) => c.path.replace(/\\/g, '/')));
    const fingerprints = buildFingerprintsForChunkPaths(uniqPathsFinal, diskByRel);

    await writeVectorIndex({
      v: 1 as const,
      root: resolved,
      provider: embed.provider,
      model: embed.model,
      updatedAt: Date.now(),
      dim: merged.length ? merged[0].emb.length : existing.dim,
      chunks: merged,
      fingerprints,
    });

    const rebuiltFiles = rebuildPaths.size;
    return {
      ok: true as const,
      fileCount: diskMetas.length,
      chunkCount: merged.length,
      truncated: mergedTruncated,
      root: resolved,
      reusedChunks: kept.length,
      rebuiltFiles,
    };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: `增量索引失败：${m}` };
  }
}
