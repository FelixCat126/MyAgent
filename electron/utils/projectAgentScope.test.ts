// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithinProjectRoot, resolveProjectAgentPath, resolveProjectAgentScope } from './projectAgentScope';

let fixture = '';
let root = '';
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(process.cwd(), '.test-project-scope-'));
  root = path.join(fixture, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'report.md'), 'report');
  await fs.writeFile(path.join(fixture, 'private.md'), 'private');
});
afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

describe('project file scope', () => {
  it('keeps global access unchanged but rejects a project without a root', async () => {
    expect(await resolveProjectAgentScope({})).toEqual({ ok: true, value: null });
    expect((await resolveProjectAgentScope({ scoped: true, root: '' })).ok).toBe(false);
    expect((await resolveProjectAgentScope({ scoped: true, root: 'relative' })).ok).toBe(false);
  });
  it('allows only real files under the selected directory, with clear containment boundaries', async () => {
    const scope = await resolveProjectAgentScope({ scoped: true, root });
    if (!scope.ok || !scope.value) throw new Error('fixture invalid');
    expect(await resolveProjectAgentPath('report.md', scope.value)).toEqual({ ok: true, value: path.join(root, 'report.md') });
    expect(await resolveProjectAgentPath('', scope.value, true)).toEqual({ ok: true, value: root });
    expect((await resolveProjectAgentPath(path.join(fixture, 'private.md'), scope.value)).ok).toBe(false);
    expect((await resolveProjectAgentPath('../private.md', scope.value)).ok).toBe(false);
    expect((await resolveProjectAgentPath('folder/../report.md', scope.value)).ok).toBe(false);
    expect(isWithinProjectRoot(root, `${root}-other/report.md`)).toBe(false);
  });
  it('rejects file and directory symlinks even when addressed with a project-relative name', async () => {
    await fs.symlink(path.join(fixture, 'private.md'), path.join(root, 'linked.md'));
    await fs.symlink(fixture, path.join(root, 'linked-directory'));
    await fs.symlink(path.join(root, 'report.md'), path.join(root, 'internal-link.md'));
    const scope = await resolveProjectAgentScope({ scoped: true, root });
    if (!scope.ok || !scope.value) throw new Error('fixture invalid');
    expect((await resolveProjectAgentPath('linked.md', scope.value)).ok).toBe(false);
    expect((await resolveProjectAgentPath('linked-directory/private.md', scope.value)).ok).toBe(false);
    expect((await resolveProjectAgentPath('internal-link.md', scope.value)).ok).toBe(false);
  });
  it('respects denied paths and rejects missing directories/files', async () => {
    expect((await resolveProjectAgentScope({ scoped: true, root, deniedPaths: [root] })).ok).toBe(false);
    expect((await resolveProjectAgentScope({ scoped: true, root: path.join(fixture, 'absent') })).ok).toBe(false);
    const scope = await resolveProjectAgentScope({ scoped: true, root, deniedPaths: [path.join(root, 'report.md')] });
    if (!scope.ok || !scope.value) throw new Error('fixture invalid');
    expect((await resolveProjectAgentPath('report.md', scope.value)).ok).toBe(false);
    expect((await resolveProjectAgentPath('missing.md', scope.value)).ok).toBe(false);
  });
});
