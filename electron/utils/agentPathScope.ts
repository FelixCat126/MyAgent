import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandUserPath } from './expandUserPath';

/** 解析并去重路径列表 */
export function normalizeAgentRoots(roots: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    const t = String(r || '').trim();
    if (!t) continue;
    const resolved = path.resolve(expandUserPath(t));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** @deprecated 工作区 sandbox；Agent 全机策略请用 resolveAgentPath */
export function isPathWithinAgentRoots(absPath: string, roots: string[]): boolean {
  const resolved = path.resolve(absPath);
  for (const root of roots) {
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/** @deprecated 工作区 sandbox；Agent 全机策略请用 resolveAgentPath */
export function resolveScopedAgentPath(
  relOrAbs: string,
  roots: string[]
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = String(relOrAbs || '').trim();
  if (!trimmed) return { ok: false, error: '路径为空' };
  if (!roots.length) return { ok: false, error: '未配置可访问的工作区根目录' };

  const candidates: string[] = [];
  if (path.isAbsolute(trimmed) || trimmed.startsWith('~') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    candidates.push(path.resolve(expandUserPath(trimmed)));
  } else {
    for (const root of roots) {
      candidates.push(path.resolve(root, trimmed));
    }
  }

  for (const candidate of candidates) {
    if (isPathWithinAgentRoots(candidate, roots)) {
      return { ok: true, path: candidate };
    }
  }
  return { ok: false, error: '路径不在允许的工作区范围内' };
}

export type AgentPathPolicy = {
  relRoot: string;
  deniedPaths: string[];
  searchRoots: string[];
};

function isUnderPrefix(target: string, prefix: string): boolean {
  const t = path.resolve(target);
  const p = path.resolve(prefix);
  if (t === p) return true;
  const rel = path.relative(p, t);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 内置：操作系统核心目录（始终禁止 Agent 访问） */
export function getSystemCoreBlockedPrefixes(): string[] {
  if (process.platform === 'win32') {
    const win = process.env.SystemRoot || 'C:\\Windows';
    return [win, 'C:\\Program Files\\Windows NT'].map((p) => path.resolve(p));
  }
  if (process.platform === 'darwin') {
    return ['/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/dev', '/cores', '/Library'].map((p) =>
      path.resolve(p)
    );
  }
  return ['/boot', '/dev', '/etc', '/proc', '/run', '/sys', '/usr', '/bin', '/sbin', '/var'].map((p) =>
    path.resolve(p)
  );
}

function matchesBlockedPrefix(resolved: string, prefix: string): boolean {
  if (process.platform === 'darwin' && prefix === path.resolve('/Library')) {
    return resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`);
  }
  return resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`);
}

/** 是否落在用户配置的「非授权 / 禁止」路径下 */
export function isUserDeniedAgentPath(absPath: string, deniedPaths: string[]): boolean {
  const resolved = path.resolve(absPath);
  for (const deny of normalizeAgentRoots(deniedPaths)) {
    if (resolved === deny || isUnderPrefix(resolved, deny)) return true;
  }
  return false;
}

/** 是否属于内置系统核心路径 */
export function isSystemCoreBlockedPath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const home = path.resolve(os.homedir());
  if (isUnderPrefix(resolved, home)) return false;

  for (const prefix of getSystemCoreBlockedPrefixes()) {
    if (matchesBlockedPrefix(resolved, prefix)) return true;
  }
  return false;
}

/** Agent 是否禁止访问该路径（系统核心 + 用户非授权列表） */
export function isAgentPathBlocked(absPath: string, deniedPaths: string[]): boolean {
  const resolved = path.resolve(absPath);
  if (isSystemCoreBlockedPath(resolved)) return true;
  if (isUserDeniedAgentPath(resolved, deniedPaths)) return true;
  return false;
}

export function isAgentPathAllowed(absPath: string, deniedPaths: string[]): boolean {
  return !isAgentPathBlocked(absPath, deniedPaths);
}

/** 文件名检索 / 列目录的默认扫描根（用户目录 + 外置卷，跳过禁止路径） */
export function getAgentSearchRoots(deniedPaths: string[]): string[] {
  const roots = new Set<string>();
  const home = path.resolve(os.homedir());
  if (!isAgentPathBlocked(home, deniedPaths)) roots.add(home);

  if (process.platform === 'darwin') {
    try {
      for (const name of fs.readdirSync('/Volumes')) {
        if (!name || name.startsWith('.')) continue;
        const p = path.resolve('/Volumes', name);
        if (!isAgentPathBlocked(p, deniedPaths)) roots.add(p);
      }
    } catch {
      /* ignore */
    }
  }

  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\`;
      try {
        fs.accessSync(p, fs.constants.R_OK);
        const resolved = path.resolve(p);
        if (!isAgentPathBlocked(resolved, deniedPaths)) roots.add(resolved);
      } catch {
        /* skip */
      }
    }
  }

  if (process.platform === 'linux') {
    for (const mountRoot of ['/mnt', '/media']) {
      try {
        for (const name of fs.readdirSync(mountRoot)) {
          if (!name || name.startsWith('.')) continue;
          const p = path.resolve(mountRoot, name);
          if (!isAgentPathBlocked(p, deniedPaths)) roots.add(p);
        }
      } catch {
        /* ignore */
      }
    }
  }

  return [...roots];
}

export function toAgentDisplayPath(absPath: string): string {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(absPath);
  const rel = path.relative(home, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join('/')}`;
  }
  return resolved;
}

export function buildAgentPathPolicy(deniedPaths: string[]): AgentPathPolicy {
  const denied = normalizeAgentRoots(deniedPaths);
  return {
    relRoot: path.resolve(os.homedir()),
    deniedPaths: denied,
    searchRoots: getAgentSearchRoots(denied),
  };
}

/** 解析 Agent 读文件路径：相对路径依次尝试 ~/、~/Documents/、~/Downloads/ 等 */
export function resolveAgentReadPath(
  relOrAbs: string,
  deniedPaths: string[]
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = String(relOrAbs || '').trim();
  if (!trimmed) return { ok: false, error: '路径为空' };

  if (path.isAbsolute(trimmed) || trimmed.startsWith('~') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    const resolved = path.resolve(expandUserPath(trimmed));
    if (isAgentPathBlocked(resolved, deniedPaths)) {
      return {
        ok: false,
        error: isSystemCoreBlockedPath(resolved)
          ? '该路径属于操作系统核心目录，Agent 不可访问'
          : '该路径在用户配置的非授权列表中，Agent 不可访问',
      };
    }
    return { ok: true, path: resolved };
  }

  const home = path.resolve(os.homedir());
  const candidates = [
    path.resolve(home, trimmed),
    path.resolve(home, 'Documents', trimmed),
    path.resolve(home, 'Downloads', trimmed),
    path.resolve(home, 'Desktop', trimmed),
    path.resolve(home, 'Pictures', trimmed),
    path.resolve(home, 'Movies', trimmed),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isAgentPathBlocked(candidate, deniedPaths)) continue;
    try {
      fs.accessSync(candidate);
      return { ok: true, path: candidate };
    } catch {
      /* try next */
    }
  }

  const fallback = path.resolve(home, 'Documents', trimmed);
  if (isAgentPathBlocked(fallback, deniedPaths)) {
    return { ok: false, error: '该路径在用户配置的非授权列表中，Agent 不可访问' };
  }
  return { ok: false, error: `ENOENT: no such file or directory, stat '${fallback}'` };
}

/** 解析 Agent 工具路径：默认相对路径以用户主目录为基准；拦截系统核心与用户非授权路径 */
export function resolveAgentPath(
  relOrAbs: string,
  deniedPaths: string[]
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = String(relOrAbs || '').trim();
  if (!trimmed) return { ok: false, error: '路径为空' };

  const relRoot = path.resolve(os.homedir());
  let candidate: string;
  if (path.isAbsolute(trimmed) || trimmed.startsWith('~') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    candidate = path.resolve(expandUserPath(trimmed));
  } else {
    candidate = path.resolve(relRoot, trimmed);
  }

  if (isAgentPathBlocked(candidate, deniedPaths)) {
    return {
      ok: false,
      error: isSystemCoreBlockedPath(candidate)
        ? '该路径属于操作系统核心目录，Agent 不可访问'
        : '该路径在用户配置的非授权列表中，Agent 不可访问',
    };
  }

  return { ok: true, path: candidate };
}
