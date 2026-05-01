import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
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
  updatedAt: number;
  dim: number;
  chunks: VectorChunkV1[];
  /** 相对工作区路径（POSIX）→ 指纹；旧索引无此字段时首次「增量」会退化为全文重建 */
  fingerprints?: Record<string, VectorFileFingerprintV1>;
};

function knowledgeDir(): string {
  return path.join(app.getPath('userData'), 'knowledge');
}

export function vectorIndexFilePath(): string {
  return path.join(knowledgeDir(), 'vector-index-v1.json');
}

export async function readVectorIndex(): Promise<VectorIndexFileV1 | null> {
  const p = vectorIndexFilePath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw) as VectorIndexFileV1;
    if (j.v !== 1 || !j.chunks) return null;
    return j;
  } catch {
    return null;
  }
}

export async function writeVectorIndex(data: VectorIndexFileV1): Promise<void> {
  const dir = knowledgeDir();
  await fs.mkdir(dir, { recursive: true });
  const p = vectorIndexFilePath();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, p);
}

export function rootsMatchIndex(stored: string, current: string): boolean {
  return path.resolve(stored) === path.resolve(current);
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
  const idx = await readVectorIndex();
  if (!idx || !idx.chunks.length) {
    return { ok: false, error: '尚未建立向量索引。请在设置中执行「重建索引」并确保嵌入配置正确。' };
  }
  if (!rootsMatchIndex(idx.root, args.root)) {
    return {
      ok: false,
      error: `当前索引根目录为「${idx.root}」，与工作区根路径不一致，请重新建索引。`,
    };
  }
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
  if (idx.dim > 0 && qv.length !== idx.dim) {
    return { ok: false, error: `查询向量维数 ${qv.length} 与索引维数 ${idx.dim} 不一致，请用同一嵌入模型重新建索引。` };
  }
  const k = Math.max(1, Math.min(20, args.topK));
  const embs = idx.chunks.map((c) => c.emb);
  const ranked = rankByCosine(qv, embs);
  const pick = selectChunkIndicesByRelevance(ranked, k);
  const parts: string[] = [];
  let used = 0;
  for (const i of pick) {
    const ch = idx.chunks[i];
    if (!ch) continue;
    const block = `《${ch.path}》\n${ch.text}\n`;
    if (parts.join('\n---\n').length + block.length > args.maxChars) break;
    parts.push(block);
    used++;
  }
  return {
    ok: true,
    text: parts.join('\n---\n').trim(),
    meta: { chunkCount: idx.chunks.length, usedChunks: used },
  };
}
