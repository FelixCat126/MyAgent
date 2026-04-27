import { ipcMain } from 'electron';
import path from 'path';
import { expandUserPath } from '../utils/expandUserPath';
import { collectWorkspaceChunks } from '../utils/workspaceIndex';
import { fetchEmbeddingsBatched, type EmbeddingProviderKey } from '../utils/embeddingClient';
import {
  readVectorIndex,
  searchIndex,
  writeVectorIndex,
  type VectorChunkV1,
} from '../utils/vectorIndexPersistence';

type EmbedPayload = {
  provider: EmbeddingProviderKey;
  baseUrl: string;
  apiKey?: string;
  model: string;
  volcMultimodal?: boolean;
};

function normalizePayload(p: unknown): EmbedPayload | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const pr = o.provider;
  if (pr !== 'openai' && pr !== 'ollama') return null;
  const baseUrl = String(o.baseUrl || '').trim();
  const model = String(o.model || '').trim();
  if (!baseUrl || !model) return null;
  return {
    provider: pr,
    baseUrl,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : undefined,
    model,
    volcMultimodal: typeof o.volcMultimodal === 'boolean' ? o.volcMultimodal : undefined,
  };
}

ipcMain.handle(
  'knowledge-index-workspace',
  async (_e, arg: { root: string; embed: EmbedPayload | unknown }) => {
    const rawRoot = String((arg as { root?: string })?.root || '').trim();
    if (!rawRoot) return { ok: false as const, error: '工作区根路径为空' };
    const root = path.resolve(expandUserPath(rawRoot));
    const embed = normalizePayload((arg as { embed?: unknown })?.embed);
    if (!embed) return { ok: false as const, error: '嵌入配置无效：请检查提供商、服务地址与模型名' };

    const { chunks, fileCount, truncated } = await collectWorkspaceChunks(root);
    if (!chunks.length) {
      return {
        ok: false as const,
        error: '未发现可索引内容（或超出文件/分块限制）。请确认目录含 .md / .txt / .docx / .xlsx 等。',
        fileCount: 0,
        chunkCount: 0,
      };
    }
    const texts = chunks.map((c) => c.text);
    let vectors: number[][];
    try {
      vectors = await fetchEmbeddingsBatched(texts, {
        provider: embed.provider,
        baseUrl: embed.baseUrl,
        apiKey: embed.apiKey,
        model: embed.model,
        volcMultimodal: embed.volcMultimodal,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: `嵌入请求失败：${m}` };
    }
    if (vectors.length !== chunks.length) {
      return { ok: false as const, error: '嵌入条数与分块数不一致' };
    }
    const dim = vectors[0]?.length || 0;
    if (!dim) return { ok: false as const, error: '得到空向量' };

    const vchunks: VectorChunkV1[] = chunks.map((c, i) => ({
      id: c.id,
      path: c.path,
      text: c.text,
      emb: vectors[i],
    }));
    const resolved = root;
    const data = {
      v: 1 as const,
      root: resolved,
      provider: embed.provider,
      model: embed.model,
      updatedAt: Date.now(),
      dim,
      chunks: vchunks,
    };
    try {
      await writeVectorIndex(data);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: `索引写入失败：${m}` };
    }
    return {
      ok: true as const,
      fileCount,
      chunkCount: vchunks.length,
      truncated,
      root: resolved,
    };
  }
);

ipcMain.handle(
  'knowledge-search',
  async (
    _e,
    arg: {
      root: string;
      query: string;
      topK: number;
      maxChars: number;
      embed: EmbedPayload | unknown;
    }
  ) => {
    const rawRoot = String(arg?.root || '').trim();
    if (!rawRoot) return { ok: false as const, error: '工作区根路径为空' };
    const root = path.resolve(expandUserPath(rawRoot));
    const query = String(arg?.query || '');
    const topK = Math.max(1, Math.min(20, Number(arg?.topK) || 5));
    const maxChars = Math.max(500, Math.min(50_000, Number(arg?.maxChars) || 8000));
    const embed = normalizePayload(arg?.embed);
    if (!embed) return { ok: false as const, error: '嵌入配置无效' };
    return searchIndex({ root, query, topK, maxChars, embed });
  }
);

ipcMain.handle('knowledge-index-status', async () => {
  const idx = await readVectorIndex();
  if (!idx) {
    return { ok: true as const, chunkCount: 0, root: null as string | null, model: null as string | null, updatedAt: 0 };
  }
  return {
    ok: true as const,
    chunkCount: idx.chunks.length,
    root: idx.root,
    model: idx.model,
    updatedAt: idx.updatedAt,
  };
});

console.log('✅ 向量知识库 IPC 已注册');
