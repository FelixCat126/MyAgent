import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import { extractTextFromPath } from './documentText';
import { chunkText } from './chunkText';

const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  '.next',
  '__pycache__',
  'target',
  'vendor',
]);

const ALLOWED_EXT = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.csv',
  '.docx',
  '.xlsx',
  '.xlsm',
]);

const MAX_DEPTH = 8;
const MAX_FILES = 400;
/** 单文件参与索引的上限（大于此仍跳过，避免 IO/内存尖峰；聊天附件另有限制） */
export const MAX_INDEX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS_TOTAL = 2500;

function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true;
  return SKIP_NAMES.has(name);
}

export type WorkspaceIndexedFileMeta = {
  absolutePath: string;
  /** 相对工作区根，使用 `/` 分隔符 */
  relPosix: string;
  mtimeMs: number;
  size: number;
};

/** 将绝对路径转为相对根的 POSIX 风格键（与 chunk.path 一致） */
export function toRelPosix(normRoot: string, absolutePath: string): string {
  const rel = path.relative(normRoot, absolutePath) || path.basename(absolutePath);
  return rel.split(path.sep).join('/');
}

async function listIndexedFileMetas(root: string): Promise<WorkspaceIndexedFileMeta[]> {
  const out: WorkspaceIndexedFileMeta[] = [];
  const normRoot = path.resolve(root);

  async function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_INDEX_FILE_BYTES) continue;
        if (!full.startsWith(normRoot)) continue;
        out.push({
          absolutePath: full,
          relPosix: toRelPosix(normRoot, full),
          mtimeMs: Math.trunc(st.mtimeMs),
          size: st.size,
        });
      } catch {
        continue;
      }
    }
  }

  await walk(normRoot, 0);
  return out;
}

export type WorkspaceChunk = { id: string; path: string; text: string };

/**
 * 单文件提取分块（用于全量与增量索引）
 */
export async function chunksForIndexedFile(
  _normRoot: string,
  meta: WorkspaceIndexedFileMeta,
  globalChunkCount: { n: number }
): Promise<WorkspaceChunk[]> {
  const out: WorkspaceChunk[] = [];
  if (globalChunkCount.n >= MAX_CHUNKS_TOTAL) return out;
  let text: string;
  let kind: string;
  try {
    const r = await extractTextFromPath(meta.absolutePath);
    text = r.text;
    kind = r.kind;
  } catch {
    return out;
  }
  if (!text.trim() || kind === 'unsupported' || kind === 'xls-legacy' || kind === 'doc-legacy') {
    return out;
  }
  const rel = meta.relPosix;
  const pieces = chunkText(text);
  for (let i = 0; i < pieces.length; i++) {
    if (globalChunkCount.n >= MAX_CHUNKS_TOTAL) break;
    const p = pieces[i];
    out.push({
      id: `${rel}#${i}`,
      path: rel,
      text: p,
    });
    globalChunkCount.n++;
  }
  return out;
}

/**
 * 遍历工作区，提取可索引文本并切块
 */
export async function collectWorkspaceChunks(root: string): Promise<{
  chunks: WorkspaceChunk[];
  fileCount: number;
  truncated: boolean;
}> {
  const norm = path.resolve(String(root || '').trim());
  const metas = await listIndexedFileMetas(norm);
  const chunks: WorkspaceChunk[] = [];
  let truncated = false;
  const globalCount = { n: 0 };

  for (const meta of metas) {
    if (globalCount.n >= MAX_CHUNKS_TOTAL) {
      truncated = true;
      break;
    }
    const piece = await chunksForIndexedFile(norm, meta, globalCount);
    chunks.push(...piece);
  }

  return { chunks, fileCount: metas.length, truncated };
}

/** 供增量索引：当前磁盘上可建索引的文件及其指纹 */
export async function listWorkspaceFilesForIncremental(root: string): Promise<WorkspaceIndexedFileMeta[]> {
  return listIndexedFileMetas(path.resolve(String(root || '').trim()));
}
