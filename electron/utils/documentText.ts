/**
 * 从本地路径提取可送入模型的纯文本 / Markdown（Excel 转为 Markdown 表）
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { isSystemCoreBlockedPath } from './agentPathScope';
import { readTable, readWorkbook, tableToText } from '../document-workbench/table';
import { createOfflineOcr, extractPdfPages } from '../document-workbench/pdf';
import type { DocumentPage } from '../../src/features/documents/types';
import mammoth from 'mammoth';

const MAX_CHARS = 120_000;
const MAX_SHEETS = 15;


function clip(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_CHARS) return t;
  return `${t.slice(0, MAX_CHARS)}\n\n…（已截断，共 ${t.length} 字，仅保留前 ${MAX_CHARS} 字）`;
}

export const DOCUMENT_TEXT_MAX_CHARS = MAX_CHARS;

/** 按 BOM / UTF-8 合法性识别编码：UTF-8、UTF-16LE/BE、无 BOM 的 UTF-16、GBK */
export function decodeTextBuffer(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const sample = buf.subarray(0, 4096);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? oddZero++ : evenZero++;
  const half = sample.length / 2;
  if (half >= 2 && oddZero > half * 0.3 && evenZero < half * 0.05) return new TextDecoder('utf-16le').decode(buf);
  if (half >= 2 && evenZero > half * 0.3 && oddZero < half * 0.05) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

export async function readTextFileDecoded(filePath: string): Promise<string> {
  return decodeTextBuffer(await fs.readFile(filePath));
}

/** 凭据 / 密钥类位置：读文件类 IPC 一律拒绝 */
const SENSITIVE_HOME_ENTRIES = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.config/gcloud', '.config/gh',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.bash_history', '.zsh_history',
  'Library/Keychains', 'Library/Cookies',
];

function realpathOrResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fsSync.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(realpathOrResolve(parent), path.basename(resolved));
  }
}

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 读文件类 IPC 的路径策略：拒绝系统核心目录与凭据目录；系统临时目录（拖入/生成的临时附件）放行 */
export function isSensitiveReadPath(filePath: string): boolean {
  const real = realpathOrResolve(filePath);
  if (isUnder(real, realpathOrResolve(os.tmpdir()))) return false;
  const home = realpathOrResolve(os.homedir());
  if (SENSITIVE_HOME_ENTRIES.some((entry) => isUnder(real, path.join(home, entry)))) return true;
  /** macOS 的 /etc、/var 实际位于 /private 下 */
  const unprivate = process.platform === 'darwin' && real.startsWith('/private/') ? real.slice('/private'.length) : real;
  return isSystemCoreBlockedPath(unprivate) || isSystemCoreBlockedPath(path.resolve(filePath));
}

export type DocumentExtractOptions = { signal?: AbortSignal; ocr?: boolean; sheet?: string; range?: string };
export async function extractTextFromPath(filePath: string, originalName?: string, options: DocumentExtractOptions = {}): Promise<{ text: string; kind: string; pages?: DocumentPage[]; truncated?: boolean }> {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const name = originalName || path.basename(filePath);

  if (options.signal?.aborted) throw new Error('DOCUMENT_CANCELED');
  if (ext === '.pdf') {
    const result = await extractPdfPages(filePath, options);
    const text = result.pages.map((p) => `[第 ${p.page} 页 / Page ${p.page} · ${p.method}${p.confidence !== undefined ? ` · confidence ${Math.round(p.confidence)}%` : ''}]\n${p.method === 'failed' ? `[识别失败 / Extraction failed] ${p.error}` : `${p.warning ? `[${p.warning}]\n` : ''}${p.text}`}`).join('\n\n');
    return { text: clip(text) + (result.truncated ? `\n[仅处理前 ${result.pages.length}/${result.totalPages} 页 / Page limit reached]` : ''), kind: 'pdf', pages: result.pages, truncated: result.truncated || text.length > MAX_CHARS };
  }
  if (/^\.(png|jpe?g|webp|bmp|tiff?)$/.test(ext)) {
    const worker = await createOfflineOcr(options.signal);
    try {
      const result = await worker.recognize(await fs.readFile(filePath));
      if (!result.text) throw new Error('未识别到文字 / No text recognized');
      return { text: `[OCR · confidence ${Math.round(result.confidence)}%]\n${clip(result.text)}`, kind: 'image-ocr', pages: [{ page: 1, method: 'ocr', ...result }] };
    } finally { await worker.close(); }
  }
  if (ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '.csv') {
    const raw = await readTextFileDecoded(filePath);
    return { text: clip(raw), kind: ext.slice(1) || 'text', ...(raw.trim().length > MAX_CHARS ? { truncated: true } : {}) };
  }

  if (ext === '.doc') {
    return {
      text: '【提示】二进制 .doc 暂不支持解析，请在 Word 中另存为 .docx 后再上传。',
      kind: 'doc-legacy',
    };
  }

  if (ext === '.docx') {
    const buf = await fs.readFile(filePath);
    const r = await mammoth.extractRawText({ buffer: buf });
    return { text: clip(r.value || '（Word 文档无文本内容）'), kind: 'docx', ...((r.value || '').trim().length > MAX_CHARS ? { truncated: true } : {}) };
  }

  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') {
    if (ext === '.xls') {
      return {
        text: '【提示】旧版 .xls 请另存为 .xlsx 后再上传，以便完整解析。',
        kind: 'xls-legacy',
      };
    }
    const wb = await readWorkbook(filePath);
    const sheets = options.sheet ? [options.sheet] : wb.worksheets.slice(0, MAX_SHEETS).map((s) => s.name);
    const parts: string[] = [];
    let truncated = wb.worksheets.length > MAX_SHEETS;
    for (const sheet of sheets) {
      if (options.signal?.aborted) throw new Error('DOCUMENT_CANCELED');
      const { table } = await readTable(filePath, { sheet, range: options.range, maxRows: 200 });
      parts.push(tableToText(table));
      truncated ||= table.truncated;
    }
    const joined = parts.join('\n\n');
    return { text: `【Excel: ${name}】\n${clip(joined)}`, kind: 'xlsx', truncated: truncated || joined.length > MAX_CHARS };
  }

  return {
    text: `【不支持的格式】${name}（扩展名 ${ext || '无'}），请使用 .pdf / .xlsx / .md / .txt / .docx 或图片。`,
    kind: 'unsupported',
  };
}
