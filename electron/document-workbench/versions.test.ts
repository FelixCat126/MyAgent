// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentVersionRepository } from './versions';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
describe('document import serialization', () => {
 it('imports the same source concurrently without creating duplicate document identities', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'document-capture-')); directories.push(directory); const source = path.join(directory, 'source.md'); await fs.writeFile(source, 'original');
  const repository = new DocumentVersionRepository(path.join(directory, 'versions'));
  const results = await Promise.all(Array.from({ length: 5 }, () => repository.capture(source, 'md', 'original')));
  expect(new Set(results.map(r => r.id)).size).toBe(1); expect((await repository.get(results[0].id)).versions).toHaveLength(1);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'versions/versions.json'), 'utf8')).documents).toHaveLength(1);
 });
});
