/**
 * 从本地路径提取可送入模型的纯文本 / Markdown（Excel 转为 Markdown 表）
 */
import fs from 'fs/promises';
import path from 'path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

const MAX_CHARS = 120_000;
const MAX_SHEETS = 15;
const MAX_ROWS_PER_SHEET = 200;
const MAX_COLS = 40;

function clip(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_CHARS) return t;
  return `${t.slice(0, MAX_CHARS)}\n\n…（已截断，共 ${t.length} 字，仅保留前 ${MAX_CHARS} 字）`;
}

export async function extractTextFromPath(filePath: string, originalName?: string): Promise<{ text: string; kind: string }> {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const name = originalName || path.basename(filePath);

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
    const buf = await fs.readFile(filePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const parts: string[] = [];
    let sheetCount = 0;
    for (const sheet of wb.worksheets) {
      if (sheetCount >= MAX_SHEETS) {
        parts.push(`\n…（其余工作表已省略，最多 ${MAX_SHEETS} 个）`);
        break;
      }
      sheetCount++;
      const lines: string[] = [];
      lines.push(`### 工作表: ${sheet.name}`);
      const rowArr: string[][] = [];
      let n = 0;
      let truncated = false;
      sheet.eachRow({ includeEmpty: true }, (row) => {
        n++;
        if (n > MAX_ROWS_PER_SHEET) {
          truncated = true;
          return;
        }
        const cells: string[] = [];
        let maxCol = row.cellCount;
        for (let c = 1; c <= Math.min(maxCol, MAX_COLS); c++) {
          const cell = row.getCell(c);
          const v = cell.value;
          let s = '';
          if (v == null) s = '';
          else if (typeof v === 'object' && v !== null && 'text' in v) s = String((v as { text?: string }).text ?? '');
          else if (typeof v === 'object' && v !== null && 'result' in v) s = String((v as { result?: unknown }).result ?? '');
          else s = String(v);
          s = s.replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
          cells.push(s);
        }
        while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
        if (cells.length) rowArr.push(cells);
      });
      if (rowArr.length === 0) {
        lines.push('（空表）');
      } else {
        const colCount = Math.max(...rowArr.map((r) => r.length));
        const header = rowArr[0].length < colCount ? [...rowArr[0], ...Array(colCount - rowArr[0].length).fill('')] : rowArr[0];
        lines.push('| ' + header.map((c) => c || ' ').join(' | ') + ' |');
        lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
        for (let r = 1; r < rowArr.length; r++) {
          const row = rowArr[r];
          const pad = [...row];
          while (pad.length < colCount) pad.push('');
          lines.push('| ' + pad.map((c) => c || ' ').join(' | ') + ' |');
        }
        if (truncated) {
          lines.push(`\n（本表仅显示前 ${MAX_ROWS_PER_SHEET} 行）`);
        }
      }
      parts.push(lines.join('\n'));
    }
    const text = clip(parts.join('\n\n'));
    return { text: `【Excel: ${name}】\n${text}`, kind: 'xlsx' };
  }

  return {
    text: `【不支持的格式】${name}（扩展名 ${ext || '无'}），请使用 .xlsx / .md / .txt / .docx。`,
    kind: 'unsupported',
  };
}
