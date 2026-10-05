import fs from 'node:fs/promises';
import path from 'node:path';
import { expandUserPath } from './expandUserPath';
import { isAgentPathAllowed } from './agentPathScope';

export interface ProjectAgentScope { rootPath: string; originalRoot: string; deniedPaths: string[] }
export interface ProjectScopeArg { scoped?: boolean; root?: string; deniedPaths?: string[] }
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function isWithinProjectRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveProjectAgentScope(arg: ProjectScopeArg = {}): Promise<Result<ProjectAgentScope | null>> {
  if (!arg?.scoped) return { ok: true, value: null };
  const root = typeof arg.root === 'string' ? arg.root.trim() : '';
  if (!root) return { ok: false, error: '尚未授权资料目录，请先选择资料目录。' };
  if (root.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(root)) return { ok: false, error: '资料目录含无效路径片段。' };
  const expanded = expandUserPath(root);
  if (!path.isAbsolute(expanded)) return { ok: false, error: '资料目录必须是绝对路径。' };
  const originalRoot = path.resolve(expanded);
  try {
    const rootPath = await fs.realpath(originalRoot);
    const deniedPaths = arg.deniedPaths ?? [];
    if (!isAgentPathAllowed(originalRoot, deniedPaths) || !isAgentPathAllowed(rootPath, deniedPaths)) return { ok: false, error: '资料目录已被访问规则禁止。' };
    if (!(await fs.stat(rootPath)).isDirectory()) return { ok: false, error: '资料路径不是目录。' };
    return { ok: true, value: { rootPath, originalRoot, deniedPaths } };
  } catch (error) { return { ok: false, error: `无法读取资料目录：${error instanceof Error ? error.message : String(error)}` }; }
}

/** Reject traversal and child symlinks before canonical containment checks. */
export async function resolveProjectAgentPath(input: string, scope: ProjectAgentScope, allowRoot = false): Promise<Result<string>> {
  const value = input.trim();
  if (!value && !allowRoot) return { ok: false, error: '文件路径为空。' };
  if (value.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return { ok: false, error: '不能通过 ../ 访问授权资料目录外的内容。' };
  const expanded = expandUserPath(value);
  const candidate = value ? path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(scope.rootPath, expanded) : scope.rootPath;
  if (!isWithinProjectRoot(scope.rootPath, candidate) && !isWithinProjectRoot(scope.originalRoot, candidate)) return { ok: false, error: '该路径不在授权资料目录内。' };
  const lexicalRoot = isWithinProjectRoot(scope.rootPath, candidate) ? scope.rootPath : scope.originalRoot;
  try {
    let current = lexicalRoot;
    for (const part of path.relative(lexicalRoot, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) return { ok: false, error: '授权文件访问不跟随符号链接，请选择实际文件路径。' };
    }
    const actual = await fs.realpath(candidate);
    if (!isWithinProjectRoot(scope.rootPath, actual)) return { ok: false, error: '实际文件位于授权资料目录外。' };
    if (!isAgentPathAllowed(candidate, scope.deniedPaths) || !isAgentPathAllowed(actual, scope.deniedPaths)) return { ok: false, error: '该文件已被访问规则禁止。' };
    return { ok: true, value: actual };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
