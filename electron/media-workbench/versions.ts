import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaVersion } from '../../src/features/media/api';
import type { ImageGenerationParams } from '../../src/types/message';
export class MediaVersionRepository {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async all(): Promise<MediaVersion[]> { try { const items = JSON.parse(await fs.readFile(this.file, 'utf8')); if (!Array.isArray(items)) throw new Error('图片版本库格式错误 / Invalid media version data'); return items; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } }
  async record(images: { path: string; width: number; height: number }[], params: ImageGenerationParams): Promise<void> {
    const operation = this.pending.then(async () => {
      const versions = await this.all(); const timestamp = Date.now();
      for (const image of images) {
        if (versions.some((v) => v.path === image.path)) continue;
        versions.push({ id: randomUUID(), path: image.path, createdAt: timestamp, prompt: params.prompt, modelId: params.modelId, model: params.imageGeneratorConfig?.model, parentPaths: (params.referenceImages ?? []).filter((r) => !/^(data:|https?:)/i.test(r)), masked: Boolean(params.maskImage), width: image.width, height: image.height });
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(versions), { mode: 0o600 }); await fs.rename(temp, this.file); } finally { await fs.unlink(temp).catch(() => {}); }
    }); this.pending = operation.catch(() => {}); await operation;
  }
  async family(filePath: string): Promise<MediaVersion[]> {
    const versions = await this.all(); const included = new Set([filePath]); let changed = true;
    while (changed) { changed = false; for (const v of versions) if (included.has(v.path) || v.parentPaths.some((p) => included.has(p))) for (const p of [v.path, ...v.parentPaths]) if (!included.has(p)) { included.add(p); changed = true; } }
    const family = versions.filter((v) => included.has(v.path));
    for (const p of included) if (!family.some((v) => v.path === p)) family.unshift({ id: p, path: p, parentPaths: [], createdAt: 0, masked: false });
    return Promise.all(family.map(async (v) => ({ ...v, missing: !(await fs.stat(v.path).then((s) => s.isFile()).catch(() => false)) })));
  }
}
