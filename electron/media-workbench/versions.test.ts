// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaVersionRepository } from './versions';
describe('image version relationships', () => {
  it('persists edit lineage across restarts and distinguishes deleted inputs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-media-'));
    try {
      const first = path.join(dir, 'first.png'), second = path.join(dir, 'second.png'), third = path.join(dir, 'third.png'); await Promise.all([first, second, third].map((p) => fs.writeFile(p, 'fixture')));
      const file = path.join(dir, 'versions.json'); const store = new MediaVersionRepository(file); await store.record([{ path: second, width: 64, height: 64 }], { prompt: 'edit 1', referenceImages: [first], maskImage: 'fixture-mask' }); await store.record([{ path: third, width: 64, height: 64 }], { prompt: 'edit 2', referenceImages: [second] }); await fs.unlink(first);
      const family = await new MediaVersionRepository(file).family(third); expect(family).toHaveLength(3); expect(family.find((v) => v.path === first)?.missing).toBe(true); expect(family.find((v) => v.path === second)?.masked).toBe(true); expect(family.find((v) => v.path === third)?.parentPaths).toEqual([second]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
