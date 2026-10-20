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

/** macOS / Windows 默认文件系统不区分大小写：比较前统一小写，避免 /USERS/x/Secret 绕过 /Users/x/secret */
function pathCompareKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isUnderPrefix(target: string, prefix: string): boolean {
  const t = pathCompareKey(target);
  const p = pathCompareKey(prefix);
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
    /** /etc、/var 在 macOS 上是 /private/etc、/private/var 的符号链接，真实路径须一并拦截 */
    return [
      '/System',
      '/usr',
      '/bin',
      '/sbin',
      '/etc',
      '/var',
      '/private/etc',
      '/private/var',
      '/dev',
      '/cores',
      '/Library',
    ].map((p) => path.resolve(p));
  }
  return ['/boot', '/dev', '/etc', '/proc', '/run', '/sys', '/usr', '/bin', '/sbin', '/var'].map((p) =>
    path.resolve(p)
  );
}

function matchesBlockedPrefix(resolved: string, prefix: string): boolean {
  return isUnderPrefix(resolved, prefix);
}

/** 主进程登记的应用自身敏感路径（持久化配置、运行时状态、日志、网关令牌等） */
let appProtectedPaths: string[] = [];

export function registerAgentProtectedPaths(paths: string[]): void {
  appProtectedPaths = normalizeAgentRoots(paths);
}

/** 内置：用户主目录下的凭证 / 密钥 / 浏览器配置目录（不可由用户配置关闭） */
export function getSensitiveAgentPrefixes(): string[] {
  const home = path.resolve(os.homedir());
  const rel = [
    '.ssh',
    '.gnupg',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.config/gcloud',
    '.config/gh',
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    'Library/Keychains',
    'Library/Cookies',
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Microsoft Edge',
    'Library/Application Support/BraveSoftware',
    'Library/Application Support/Firefox',
    'Library/Application Support/com.apple.TCC',
    '.config/google-chrome',
    '.config/chromium',
    '.mozilla',
    '.local/share/keyrings',
    'AppData/Roaming/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Protect',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Local/Google/Chrome/User Data',
    'AppData/Local/Microsoft/Edge/User Data',
    'AppData/Roaming/Mozilla/Firefox',
  ];
  return [...rel.map((r) => path.resolve(home, ...r.split('/'))), ...appProtectedPaths];
}

/** 是否属于内置敏感凭证路径 */
export function isSensitiveAgentPath(absPath: string): boolean {
  return getSensitiveAgentPrefixes().some((prefix) => isUnderPrefix(absPath, prefix));
}

/** 是否落在用户配置的「非授权 / 禁止」路径下 */
export function isUserDeniedAgentPath(absPath: string, deniedPaths: string[]): boolean {
  const resolved = path.resolve(absPath);
  for (const deny of normalizeAgentRoots(deniedPaths)) {
    if (isUnderPrefix(resolved, deny)) return true;
  }
  return false;
}

/** 当前用户临时目录（macOS 为 /var/folders/…/T，真实路径在 /private/var 下）：按用户隔离，不属于系统核心目录 */
function userTempRoots(): string[] {
  const tmp = path.resolve(os.tmpdir());
  try {
    return [tmp, fs.realpathSync.native(tmp)];
  } catch {
    return [tmp];
  }
}

/** 是否属于内置系统核心路径 */
export function isSystemCoreBlockedPath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const home = path.resolve(os.homedir());
  if (isUnderPrefix(resolved, home)) return false;
  if (process.platform === 'darwin' && userTempRoots().some((root) => isUnderPrefix(resolved, root))) return false;

  for (const prefix of getSystemCoreBlockedPrefixes()) {
    if (matchesBlockedPrefix(resolved, prefix)) return true;
  }
  return false;
}

/** Agent 是否禁止访问该路径（系统核心 + 敏感凭证 + 用户非授权列表） */
export function isAgentPathBlocked(absPath: string, deniedPaths: string[]): boolean {
  const resolved = path.resolve(absPath);
  if (isSystemCoreBlockedPath(resolved)) return true;
  if (isSensitiveAgentPath(resolved)) return true;
  if (isUserDeniedAgentPath(resolved, deniedPaths)) return true;
  return false;
}

/**
 * 解析符号链接后的真实路径；目标不存在时对最近的已存在祖先目录取 realpath 再拼回剩余段，
 * 使「~/link/a.txt → /etc/a.txt」这类穿越在文件尚未创建时也能被识别。
 */
export function realAgentPath(absPath: string): string {
  const resolved = path.resolve(absPath);
  const rest: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function agentBlockedReason(candidate: string, deniedPaths: string[]): string | null {
  for (const p of [candidate, realAgentPath(candidate)]) {
    if (isSystemCoreBlockedPath(p)) return '该路径属于操作系统核心目录，Agent 不可访问';
    if (isSensitiveAgentPath(p)) return '该路径包含密钥、凭证或应用私有数据，Agent 不可访问';
    if (isUserDeniedAgentPath(p, deniedPaths)) return '该路径在用户配置的非授权列表中，Agent 不可访问';
  }
  return null;
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
    const reason = agentBlockedReason(resolved, deniedPaths);
    if (reason) return { ok: false, error: reason };
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
    if (agentBlockedReason(candidate, deniedPaths)) continue;
    try {
      fs.accessSync(candidate);
      return { ok: true, path: candidate };
    } catch {
      /* try next */
    }
  }

  const fallback = path.resolve(home, 'Documents', trimmed);
  const fallbackReason = agentBlockedReason(fallback, deniedPaths);
  if (fallbackReason) return { ok: false, error: fallbackReason };
  const homeReason = agentBlockedReason(path.resolve(home, trimmed), deniedPaths);
  if (homeReason) return { ok: false, error: homeReason };
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

  const reason = agentBlockedReason(candidate, deniedPaths);
  if (reason) return { ok: false, error: reason };

  return { ok: true, path: candidate };
}
