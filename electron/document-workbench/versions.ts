import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentVersion } from '../../src/features/documents/types';
export type DocumentRecord = { id: string; sourcePath: string; title: string; kind: string; hash: string; activeVersionId: string; versions: DocumentVersion[] };
type Manifest = { version: 1; documents: DocumentRecord[] };
export class DocumentVersionRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(public readonly directory: string) {}
  private async manifest(): Promise<Manifest> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.directory, 'versions.json'), 'utf8')) as Manifest;
      if (parsed.version !== 1 || !Array.isArray(parsed.documents)) throw new Error('版本库格式错误 / Invalid version manifest');
      return parsed;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, documents: [] }; throw e; }
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn); this.tail = next.catch(() => {}); return next;
  }
  async findByPath(sourcePath: string): Promise<DocumentRecord | undefined> {
    return (await this.manifest()).documents.find((d) => d.sourcePath === path.resolve(sourcePath) || d.versions.some((v) => v.file.path === sourcePath));
  }
  async get(id: string): Promise<DocumentRecord> {
    const document = (await this.manifest()).documents.find((d) => d.id === id);
    if (!document) throw new Error('文档版本不存在 / Document version not found');
    return document;
  }
  async write(record: DocumentRecord, expectedActiveId?: string): Promise<void> {
    await this.exclusive(() => this.writeExclusive(record, expectedActiveId));
  }
  private async writeExclusive(record: DocumentRecord, expectedActiveId?: string): Promise<void> {
      await fs.mkdir(this.directory, { recursive: true });
      const manifest = await this.manifest(); const index = manifest.documents.findIndex((d) => d.id === record.id);
      if (expectedActiveId && index >= 0 && manifest.documents[index].activeVersionId !== expectedActiveId) throw new Error('版本已更新，请重新打开再保存 / Version changed; reopen before saving');
      if (index >= 0) manifest.documents[index] = record; else manifest.documents.push(record);
      const temp = path.join(this.directory, `versions.${randomUUID()}.tmp`);
      try { await fs.writeFile(temp, JSON.stringify(manifest), { mode: 0o600 }); await fs.rename(temp, path.join(this.directory, 'versions.json')); }
      finally { await fs.unlink(temp).catch(() => {}); }
  }
  async capture(sourcePath: string, kind: string, content: string, options: { truncated?: boolean; expectedHash?: string } = {}): Promise<DocumentRecord> {
    return this.exclusive(async () => {
    const bytes = await fs.readFile(sourcePath); const hash = createHash('sha256').update(bytes).digest('hex');
    if (options.expectedHash && hash !== options.expectedHash) throw new Error('读取期间源文件发生变化，请重新打开 / Source changed while reading; reopen');
    const previous = await this.findByPath(sourcePath);
    if (previous && previous.hash === hash) return previous;
    const id = previous?.id ?? randomUUID(); const versionId = randomUUID();
    const dir = path.join(this.directory, id); await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${versionId}${path.extname(sourcePath)}`);
    await fs.writeFile(target, bytes, { mode: 0o600 });
    const version: DocumentVersion = { id: versionId, parentId: previous?.activeVersionId, createdAt: Date.now(), label: previous ? '外部文件更新 / Source update' : '原始文件 / Original', format: path.extname(sourcePath).slice(1), file: { path: target, name: path.basename(sourcePath), size: bytes.length, type: documentMime(path.extname(sourcePath).slice(1)) }, content, truncated: options.truncated };
    const record: DocumentRecord = { id, sourcePath: path.resolve(sourcePath), title: path.basename(sourcePath), kind, hash, activeVersionId: version.id, versions: [...(previous?.versions ?? []), version] };
    try { await this.writeExclusive(record); return record; }
    catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
    });
  }
}
export function documentMime(format: string): string {
  return ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', pdf: 'application/pdf', svg: 'image/svg+xml', json: 'application/json' } as Record<string, string>)[format] ?? 'application/octet-stream';
}
