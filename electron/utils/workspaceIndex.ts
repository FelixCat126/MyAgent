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
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS_TOTAL = 2500;

function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true;
  return SKIP_NAMES.has(name);
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
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
        if (st.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      if (!full.startsWith(normRoot)) continue;
      out.push(full);
    }
  }

  await walk(normRoot, 0);
  return out;
}

export type WorkspaceChunk = { id: string; path: string; text: string };

/**
 * 遍历工作区，提取可索引文本并切块
 */
export async function collectWorkspaceChunks(root: string): Promise<{
  chunks: WorkspaceChunk[];
  fileCount: number;
  truncated: boolean;
}> {
  const norm = path.resolve(String(root || '').trim());
  const files = await listFilesRecursive(norm);
  const chunks: WorkspaceChunk[] = [];
  let truncated = false;

  for (const file of files) {
    if (chunks.length >= MAX_CHUNKS_TOTAL) {
      truncated = true;
      break;
    }
    let text: string;
    let kind: string;
    try {
      const r = await extractTextFromPath(file);
      text = r.text;
      kind = r.kind;
    } catch {
      continue;
    }
    if (!text.trim() || kind === 'unsupported' || kind === 'xls-legacy' || kind === 'doc-legacy') {
      continue;
    }
    const rel = path.relative(norm, file) || path.basename(file);
    const pieces = chunkText(text);
    for (let i = 0; i < pieces.length; i++) {
      if (chunks.length >= MAX_CHUNKS_TOTAL) {
        truncated = true;
        break;
      }
      const p = pieces[i];
      chunks.push({
        id: `${rel}#${i}`,
        path: rel,
        text: p,
      });
    }
  }

  return { chunks, fileCount: files.length, truncated };
}
