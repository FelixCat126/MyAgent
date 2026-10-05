// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveDataSourcePath } from './dataScope';

let fixture = '';
let root = '';
let report = '';
let attachment = '';
let sibling = '';
beforeEach(async () => {
  // macOS /var is intentionally blocked, so fixtures live under the workspace.
  fixture = await fs.mkdtemp(path.join(process.cwd(), '.test-data-scope-'));
  root = path.join(fixture, 'project');
  const uploads = path.join(fixture, 'uploads');
  await fs.mkdir(root); await fs.mkdir(uploads); await fs.mkdir(path.join(root, 'nested'));
  report = path.join(root, 'report.csv');
  attachment = path.join(uploads, 'selected.csv');
  sibling = path.join(uploads, 'private.csv');
  await fs.writeFile(report, 'value\n12');
  await fs.writeFile(attachment, 'value\n34');
  await fs.writeFile(sibling, 'secret\n56');
});
afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

describe('deterministic calculation data-source authorization', () => {
  it('accepts project files by relative or absolute path and preserves the explicit editor path', async () => {
    expect(await resolveDataSourcePath('report.csv', { scoped: true, root })).toBe(await fs.realpath(report));
    expect(await resolveDataSourcePath(report, { scoped: true, root })).toBe(await fs.realpath(report));
    expect(await resolveDataSourcePath('/explicit/editor/file.csv')).toBe('/explicit/editor/file.csv');
  });

  it('expands a project home-directory shorthand consistently with local file tools', async () => {
    const homeRoot = `~/${path.relative(os.homedir(), root)}`;
    expect(await resolveDataSourcePath('report.csv', { scoped: true, root: homeRoot })).toBe(await fs.realpath(report));
  });

  it('refuses traversal even when normalization would land back inside the project', async () => {
    await expect(resolveDataSourcePath('../uploads/private.csv', { scoped: true, root })).rejects.toThrow();
    await expect(resolveDataSourcePath('nested/../report.csv', { scoped: true, root })).rejects.toThrow();
    await expect(resolveDataSourcePath(`${root}/nested/../report.csv`, { scoped: true, root })).rejects.toThrow();
  });

  it('refuses project file and directory symlinks instead of reading their external targets', async () => {
    await fs.symlink(sibling, path.join(root, 'linked.csv'));
    await fs.symlink(path.dirname(sibling), path.join(root, 'linked-directory'));
    await fs.symlink(report, path.join(root, 'internal-link.csv'));
    await expect(resolveDataSourcePath('linked.csv', { scoped: true, root })).rejects.toThrow();
    await expect(resolveDataSourcePath('linked-directory/private.csv', { scoped: true, root })).rejects.toThrow();
    await expect(resolveDataSourcePath('internal-link.csv', { scoped: true, root })).rejects.toThrow();
  });

  it('allows the exact explicit attachment when no project root exists, without granting its sibling files', async () => {
    const scope = { scoped: true, root: '', attachmentPaths: [attachment] };
    expect(await resolveDataSourcePath(attachment, scope)).toBe(await fs.realpath(attachment));
    await expect(resolveDataSourcePath(sibling, scope)).rejects.toThrow();
    await expect(resolveDataSourcePath(report, scope)).rejects.toThrow();
    await expect(resolveDataSourcePath(attachment, { scoped: true, root: '' })).rejects.toThrow();
  });

  it('does not use attachment authorization to accept traversal aliases', async () => {
    await expect(resolveDataSourcePath('../uploads/selected.csv', { scoped: true, root, attachmentPaths: [attachment] })).rejects.toThrow();
  });

  it('applies denied paths before the exact attachment grant, including its canonical target', async () => {
    await expect(resolveDataSourcePath(attachment, { scoped: true, root: '', attachmentPaths: [attachment], deniedPaths: [attachment] })).rejects.toThrow('禁止');
    await expect(resolveDataSourcePath(attachment, { scoped: true, root: '', attachmentPaths: [attachment], deniedPaths: [path.dirname(attachment)] })).rejects.toThrow('禁止');
    await fs.symlink(attachment, path.join(root, 'selected-link.csv'));
    await expect(resolveDataSourcePath(path.join(root, 'selected-link.csv'), { scoped: true, root, attachmentPaths: [attachment], deniedPaths: [attachment] })).rejects.toThrow('禁止');
  });
});
