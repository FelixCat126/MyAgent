import { ipcMain } from 'electron';
import path from 'path';
import { expandUserPath } from '../utils/expandUserPath';
import {
  performFullKnowledgeIndex,
  performIncrementalKnowledgeIndex,
  type KnowledgeEmbedPayload,
} from '../utils/knowledgeIndexOperations';
import { readVectorIndex, searchIndex } from '../utils/vectorIndexPersistence';

/** 与 ipc 载荷对齐；实际校验在 incremental 模块 */
function coerceEmbedPayload(p: unknown): KnowledgeEmbedPayload | null {
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
  async (
    _e,
    arg: { root?: string; embed?: unknown; mode?: 'full' | 'incremental' }
  ) => {
    const rawRoot = String((arg as { root?: string })?.root || '').trim();
    if (!rawRoot) return { ok: false as const, error: '工作区根路径为空' };
    const embed = coerceEmbedPayload((arg as { embed?: unknown }).embed);
    if (!embed) return { ok: false as const, error: '嵌入配置无效：请检查提供商、服务地址与模型名' };
    const mode = (arg as { mode?: unknown }).mode === 'incremental' ? 'incremental' : 'full';

    if (mode === 'incremental') {
      const r = await performIncrementalKnowledgeIndex(rawRoot, embed);
      if (!r.ok) return r;
      return {
        ok: true as const,
        fileCount: r.fileCount,
        chunkCount: r.chunkCount,
        truncated: r.truncated,
        root: r.root,
        reusedChunks: r.reusedChunks,
        rebuiltFiles: r.rebuiltFiles,
      };
    }

    const r = await performFullKnowledgeIndex(rawRoot, embed);
    if (!r.ok) return r;
    return {
      ok: true as const,
      fileCount: r.fileCount,
      chunkCount: r.chunkCount,
      truncated: r.truncated,
      root: r.root,
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
      embed: unknown;
    }
  ) => {
    const rawRoot = String(arg?.root || '').trim();
    if (!rawRoot) return { ok: false as const, error: '工作区根路径为空' };
    const root = path.resolve(expandUserPath(rawRoot));
    const query = String(arg?.query || '');
    const topK = Math.max(1, Math.min(20, Number(arg?.topK) || 5));
    const maxChars = Math.max(500, Math.min(50_000, Number(arg?.maxChars) || 8000));
    const embed = coerceEmbedPayload(arg?.embed);
    if (!embed) return { ok: false as const, error: '嵌入配置无效' };
    return searchIndex({ root, query, topK, maxChars, embed });
  }
);

ipcMain.handle('knowledge-index-status', async () => {
  const idx = await readVectorIndex();
  if (!idx) {
    return {
      ok: true as const,
      chunkCount: 0,
      root: null as string | null,
      model: null as string | null,
      updatedAt: 0,
    };
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
