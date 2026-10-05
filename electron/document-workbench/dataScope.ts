import fs from 'node:fs/promises';
import path from 'node:path';
import type { DataCalculationRequest } from '../../src/features/documents/types';
import { expandUserPath } from '../utils/expandUserPath';
import { isAgentPathAllowed } from '../utils/agentPathScope';
import { resolveProjectAgentPath, resolveProjectAgentScope } from '../utils/projectAgentScope';

/** Scope is supplied by the send pipeline, never by a model's tool arguments. */
export async function resolveDataSourcePath(input: string, scope?: DataCalculationRequest['scope']): Promise<string> {
  if (!scope) return input; // The document editor's explicitly selected file.
  const denied = scope.deniedPaths ?? [];
  if (input.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(input)) throw new Error('数据路径不能包含 ../。');
  const expanded=expandUserPath(input);
  const candidate = path.isAbsolute(expanded) ? expanded : scope.root ? path.resolve(expandUserPath(scope.root),expanded) : expanded;
  const actual = await fs.realpath(candidate);
  if (!isAgentPathAllowed(candidate,denied) || !isAgentPathAllowed(actual,denied)) throw new Error('该数据文件已被访问规则禁止。');
  if (!scope.scoped) return actual;
  // Explicit user attachments grant access to that file, never its containing directory.
  for (const attachment of scope.attachmentPaths ?? []) {
    if (!path.isAbsolute(attachment)) continue;
    const canonical = await fs.realpath(attachment).catch(()=>null);
    if (canonical === actual) return actual;
  }
  const project = await resolveProjectAgentScope({ ...scope,scoped:true });
  if (!project.ok) throw new Error(project.error);
  if (!project.value) throw new Error('项目资料目录尚未授权。');
  const result = await resolveProjectAgentPath(input,project.value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
