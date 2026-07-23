/**
 * 会话导出：把 chatSession 打包为 .zip（含 JSON、Markdown、原附件、生图原图）。
 *
 * 设计要点：
 * - 纯 fflate 同步 zip（不流式——会话通常几 MB，单线程够快；主进程不阻塞 IPC 太久）
 * - 文件名按 messageId + 索引去重，避免不同消息含同名附件互相覆盖
 * - 文件不存在（用户清理过附件）时跳过并记 warnings，不让导出整体失败
 */

import fs from 'fs/promises';
import path from 'path';
import { zipSync, strToU8 } from 'fflate';
import type { ChatSession, Message, FileInfo } from '../../src/types';

/** 单条导出条目，便于 IPC 返回给 renderer 反馈 */
export interface ExportEntry {
  /** 在 zip 内的相对路径 */
  path: string;
  /** 来源：json / md / attachment / image */
  kind: 'json' | 'md' | 'attachment' | 'image';
  /** 字节数（zip 压缩后大小难精确预估，给原始大小） */
  size: number;
  /** 源文件丢失时的标记 */
  missing?: boolean;
}

export interface ExportResult {
  ok: true;
  zipPath: string;
  entries: ExportEntry[];
  warnings: string[];
}

export interface ExportFailure {
  ok: false;
  error: string;
}

function safeFileBase(name: string): string {
  /** 去掉路径分隔符 + 保留扩展名 */
  const base = path.basename(name || 'file');
  return base.replace(/[\\/:*?"<>|]/g, '_');
}

function buildSessionJson(session: ChatSession): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      messages: session.messages.map((m) => ({
        ...m,
        /** 序列化去掉不可克隆字段：imageGenProgress 是渲染态 */
        imageGenProgress: undefined,
      })),
    },
    null,
    2
  );
}

function buildMarkdown(session: ChatSession, messages: Message[]): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || '新对话'}`);
  lines.push('');
  lines.push(`- 会话 ID: \`${session.id}\``);
  lines.push(`- 创建时间: ${new Date(session.createdAt).toISOString()}`);
  lines.push(`- 消息条数: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of messages) {
    const ts = new Date(m.timestamp || Date.now()).toISOString();
    lines.push(`## [${m.role}] ${ts} (${m.model || '—'})`);
    if (m.exportHint?.document) lines.push(`*exportHint*: document=${m.exportHint.document}`);
    if (m.parentId) lines.push(`*branch parentId*: \`${m.parentId}\``);
    if (m.reasoning) {
      lines.push('');
      lines.push('> ' + m.reasoning.split('\n').join('\n> '));
    }
    lines.push('');
    lines.push(m.content || '*(空)*');
    if (m.files && m.files.length) {
      lines.push('');
      lines.push('**附件**:');
      for (const f of m.files) {
        const att = encodeAttachmentLine(f);
        lines.push(`- ${att}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function encodeAttachmentLine(f: FileInfo): string {
  /** zip 内的实际路径：attachments/<messageId>/<fileIndex>_<safeName> */
  return `${f.name} (${f.size || 0} bytes) — type=${f.type || '?'}, path=\`${f.path}\``;
}

function buildAttachmentPath(messageId: string, index: number, fileName: string): string {
  return `attachments/${messageId}/${index + 1}_${safeFileBase(fileName)}`;
}

function buildImagePath(messageId: string, index: number, name: string, mime: string): string {
  /** 生图原图：扩展名优先取 mime 子类型（image/png → png），避免 name 是 "a.txt" 之类的占位名导致后缀错乱 */
  const fromMime = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/i.exec(mime);
  const ext = fromMime
    ? `.${fromMime[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`
    : path.extname(name) || '.png';
  const base = safeFileBase(name).replace(/\.[^.]+$/, '') || 'image';
  return `images/${messageId}/${index + 1}_${base}${ext}`;
}

/** 读取所有 messages 的附件/生图原图；不存在则跳过并记 warning */
async function collectBinaryAssets(
  messages: Message[]
): Promise<{ files: Map<string, Uint8Array>; warnings: string[]; entries: ExportEntry[] }> {
  const files = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  const entries: ExportEntry[] = [];

  /** 一次性把消息 → 文件 → 路径/读取 promise 全展开，再 await all */
  const tasks: Array<Promise<void>> = [];
  for (const m of messages) {
    if (!m.files) continue;
    m.files.forEach((f, i) => {
      tasks.push(
        (async () => {
          const isImage =
            (f.type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
          const zipPath = isImage
            ? buildImagePath(m.id, i, f.name, f.type || '')
            : buildAttachmentPath(m.id, i, f.name);
          if (!f.path) {
            warnings.push(`${m.id}: ${f.name} 无 path，跳过`);
            entries.push({ path: zipPath, kind: isImage ? 'image' : 'attachment', size: 0, missing: true });
            return;
          }
          try {
            const buf = await fs.readFile(f.path);
            files.set(zipPath, new Uint8Array(buf));
            entries.push({
              path: zipPath,
              kind: isImage ? 'image' : 'attachment',
              size: buf.byteLength,
            });
          } catch {
            warnings.push(`${m.id}: 附件 ${f.name} 源文件丢失 (${f.path})`);
            entries.push({
              path: zipPath,
              kind: isImage ? 'image' : 'attachment',
              size: 0,
              missing: true,
            });
          }
        })()
      );
    });
  }
  await Promise.all(tasks);
  return { files, warnings, entries };
}

export async function buildSessionExportZip(
  session: ChatSession,
  outputPath: string
): Promise<ExportResult | ExportFailure> {
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const json = buildSessionJson(session);
    const md = buildMarkdown(session, session.messages);
    const { files, warnings, entries } = await collectBinaryAssets(session.messages);

    const zipMap: Record<string, Uint8Array> = {
      'session.json': strToU8(json),
      'messages.md': strToU8(md),
      ...Object.fromEntries(files),
    };
    const zipped = zipSync(zipMap, { level: 6 });
    await fs.writeFile(outputPath, zipped);

    const allEntries: ExportEntry[] = [
      { path: 'session.json', kind: 'json', size: json.length },
      { path: 'messages.md', kind: 'md', size: md.length },
      ...entries,
    ];
    return { ok: true, zipPath: outputPath, entries: allEntries, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
