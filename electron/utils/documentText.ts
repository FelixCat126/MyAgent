/**
 * 从本地路径提取可送入模型的纯文本 / Markdown（Excel 转为 Markdown 表）
 */
import fs from 'fs/promises';
import path from 'path';
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
    const raw = await fs.readFile(filePath, 'utf8');
    return { text: clip(raw), kind: ext.slice(1) || 'text' };
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
    return { text: clip(r.value || '（Word 文档无文本内容）'), kind: 'docx' };
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
