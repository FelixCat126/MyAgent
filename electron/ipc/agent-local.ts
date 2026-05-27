import { ipcMain } from 'electron';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Dirent } from 'fs';
import { extractTextFromPath } from '../utils/documentText';
import {
  buildAgentPathPolicy,
  isAgentPathAllowed,
  resolveAgentPath,
  resolveAgentReadPath,
  toAgentDisplayPath,
} from '../utils/agentPathScope';
import { toRelPosix } from '../utils/workspaceIndex';

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

const DEFAULT_EXT = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.csv',
  '.docx',
  '.xlsx',
  '.xlsm',
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif']);

function resolveFindExtensions(arg: {
  extensions?: string[];
  fileKind?: 'document' | 'image';
}): Set<string> {
  if (Array.isArray(arg.extensions) && arg.extensions.length) {
    const s = new Set<string>();
    for (const item of arg.extensions) {
      const ext = String(item || '').trim().toLowerCase();
      if (!ext) continue;
      s.add(ext.startsWith('.') ? ext : `.${ext}`);
    }
    if (s.size) return s;
  }
  if (arg.fileKind === 'image') return IMAGE_EXT;
  return DEFAULT_EXT;
}

const MAX_LIST_DEPTH = 6;
const MAX_LIST_ENTRIES = 200;
const MAX_FIND_RESULTS = 40;
const MAX_READ_CHARS = 120_000;

function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true;
  return SKIP_NAMES.has(name);
}

function coerceExtensions(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const s = new Set<string>();
  for (const item of raw) {
    const ext = String(item || '').trim().toLowerCase();
    if (!ext) continue;
    s.add(ext.startsWith('.') ? ext : `.${ext}`);
  }
  return s.size ? s : null;
}

function policyFromArg(arg: { deniedPaths?: string[] }) {
  return buildAgentPathPolicy(arg?.deniedPaths ?? []);
}

ipcMain.handle(
  'agent-local-list',
  async (
    _e,
    arg: {
      deniedPaths?: string[];
      subpath?: string;
      maxDepth?: number;
      extensions?: string[];
    }
  ) => {
    const policy = policyFromArg(arg);
    const scoped = arg?.subpath
      ? resolveAgentPath(String(arg.subpath), policy.deniedPaths)
      : { ok: true as const, path: policy.relRoot };
    if (!scoped.ok) return scoped;

    const maxDepth = Math.max(1, Math.min(MAX_LIST_DEPTH, Number(arg?.maxDepth) || 3));
    const extFilter = coerceExtensions(arg?.extensions) ?? DEFAULT_EXT;
    const entries: { path: string; rel: string; kind: 'file' | 'dir'; size?: number }[] = [];
    const listRoot = scoped.path;

    async function walk(dir: string, root: string, depth: number) {
      if (depth > maxDepth || entries.length >= MAX_LIST_ENTRIES) return;
      if (!isAgentPathAllowed(dir, policy.deniedPaths)) return;
      let items: Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        throw e;
      }
      for (const ent of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const full = path.join(dir, ent.name);
        if (!isAgentPathAllowed(full, policy.deniedPaths)) continue;
        if (ent.isDirectory()) {
          if (shouldSkipDir(ent.name)) continue;
          entries.push({
            path: full,
            rel: toRelPosix(root, full),
            kind: 'dir',
          });
          if (depth < maxDepth) await walk(full, root, depth + 1);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!extFilter.has(ext)) continue;
        const st = await fs.stat(full);
        entries.push({
          path: full,
          rel: toRelPosix(root, full),
          kind: 'file',
          size: st.size,
        });
      }
    }

    try {
      const st = await fs.stat(scoped.path);
      if (st.isFile()) {
        return {
          ok: true as const,
          listBase: toAgentDisplayPath(scoped.path),
          entries: [
            {
              path: scoped.path,
              rel: path.basename(scoped.path),
              displayPath: toAgentDisplayPath(scoped.path),
              kind: 'file' as const,
              size: st.size,
            },
          ],
        };
      }
      await walk(listRoot, listRoot, 1);
      const listBase = arg?.subpath ? toAgentDisplayPath(listRoot) : toAgentDisplayPath(policy.relRoot);
      return {
        ok: true as const,
        listBase,
        entries: entries.map((e) => ({
          ...e,
          displayPath: toAgentDisplayPath(e.path),
        })),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  }
);

ipcMain.handle(
  'agent-local-find-by-name',
  async (
    _e,
    arg: {
      deniedPaths?: string[];
      pattern?: string;
      limit?: number;
      extensions?: string[];
      fileKind?: 'document' | 'image';
    }
  ) => {
    const policy = policyFromArg(arg);
    const pattern = String(arg?.pattern || '').trim().toLowerCase();
    if (!pattern) return { ok: false as const, error: 'pattern 为空' };
    const limit = Math.max(1, Math.min(MAX_FIND_RESULTS, Number(arg?.limit) || 20));
    const allowedExt = resolveFindExtensions(arg);
    const matches: { path: string; rel: string; name: string; displayPath: string; size?: number }[] = [];

    async function walk(dir: string, root: string, depth: number) {
      if (depth > MAX_LIST_DEPTH || matches.length >= limit) return;
      if (!isAgentPathAllowed(dir, policy.deniedPaths)) return;
      let items: Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of items) {
        if (matches.length >= limit) return;
        const full = path.join(dir, ent.name);
        if (!isAgentPathAllowed(full, policy.deniedPaths)) continue;
        if (ent.isDirectory()) {
          if (shouldSkipDir(ent.name)) continue;
          await walk(full, root, depth + 1);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!allowedExt.has(ext)) continue;
        if (!ent.name.toLowerCase().includes(pattern)) continue;
        let size: number | undefined;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          size = undefined;
        }
        matches.push({
          path: full,
          rel: toRelPosix(root, full),
          name: ent.name,
          displayPath: toAgentDisplayPath(full),
          size,
        });
      }
    }

    for (const root of policy.searchRoots) {
      try {
        const st = await fs.stat(root);
        if (!st.isDirectory()) continue;
        await walk(root, root, 0);
      } catch {
        /* skip bad root */
      }
    }

    return { ok: true as const, matches };
  }
);

ipcMain.handle(
  'agent-local-read',
  async (
    _e,
    arg: {
      deniedPaths?: string[];
      path?: string;
      maxChars?: number;
    }
  ) => {
    const policy = policyFromArg(arg);
    const scoped = resolveAgentReadPath(String(arg?.path || ''), policy.deniedPaths);
    if (!scoped.ok) return scoped;

    const maxChars = Math.max(1000, Math.min(MAX_READ_CHARS, Number(arg?.maxChars) || MAX_READ_CHARS));
    try {
      const st = await fs.stat(scoped.path);
      if (!st.isFile()) return { ok: false as const, error: '不是文件' };
      const { text: rawText, kind } = await extractTextFromPath(scoped.path);
      let text = rawText;
      let truncated = false;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
      }
      return {
        ok: true as const,
        path: scoped.path,
        rel: toAgentDisplayPath(scoped.path),
        text,
        kind,
        truncated,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  }
);

ipcMain.handle('agent-local-is-in-scope', async (_e, arg: { deniedPaths?: string[]; path?: string }) => {
  const p = String(arg?.path || '').trim();
  if (!p) return { ok: true as const, allowed: false };
  const resolved = resolveAgentPath(p, arg?.deniedPaths ?? []);
  if (!resolved.ok) return { ok: true as const, allowed: false };
  return { ok: true as const, allowed: true };
});

ipcMain.handle('agent-local-home-dir', async () => {
  return { ok: true as const, path: os.homedir() };
});

console.log('✅ Agent 本机文件 IPC 已注册');
