/**
 * 将 Markdown 中的 GFM 表格解析并写入 Excel；纯 MD 保存为文本；粗粒度 docx
 */
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';

export function parseMarkdownTables(md: string): { name: string; rows: string[][] }[] {
  const lines = md.split(/\r?\n/);
  const tables: { name: string; rows: string[][] }[] = [];
  let i = 0;
  let tableIdx = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.includes('|')) {
      i++;
      continue;
    }
    const row1 = splitTableRow(line);
    if (row1.length < 2) {
      i++;
      continue;
    }
    const sep = lines[i + 1];
    if (!sep || !isSeparatorTableRow(sep)) {
      i++;
      continue;
    }
    const rows: string[][] = [row1];
    i += 2;
    while (i < lines.length) {
      const L = lines[i];
      if (!L.trim() || !L.includes('|')) break;
      const r = splitTableRow(L);
      if (r.length === 0) break;
      rows.push(r);
      i++;
    }
    if (rows.length >= 1) {
      const width = Math.max(...rows.map((r) => r.length));
      const normalized = rows.map((r) => {
        const x = [...r];
        while (x.length < width) x.push('');
        return x.slice(0, width);
      });
      tableIdx++;
      tables.push({ name: `Table${tableIdx}`, rows: normalized });
    }
  }
  return tables;
}

function splitTableRow(line: string): string[] {
  const t = line.trim();
  if (!t.includes('|')) return [];
  const inner = t.startsWith('|') ? t.slice(1) : t;
  const noTail = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  return noTail.split('|').map((c) => c.trim());
}

function isSeparatorTableRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((c) => {
    const x = c.replace(/\s/g, '');
    return x.length > 0 && /^:?-+:?:?$/.test(x);
  });
}

export async function markdownToXlsxBuffer(markdown: string): Promise<Buffer> {
  const tables = parseMarkdownTables(markdown);
  const wb = new ExcelJS.Workbook();
  if (tables.length === 0) {
    const s = wb.addWorksheet('Content');
    s.getCell(1, 1).value = '（未识别到 Markdown 管道表格，可将表格用 | 列1 | 列2 | 格式书写）';
    s.getCell(2, 1).value = markdown.slice(0, 5000);
  } else {
    for (const { name, rows } of tables.slice(0, 30)) {
      const safe = name.replace(/[\\/*?:\[\]]/g, '_').slice(0, 25) || 'Sheet';
      const sheet = wb.addWorksheet(safe);
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          sheet.getCell(r + 1, c + 1).value = rows[r][c];
        }
      }
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/** 将整段 MD 按行变成 Word 段落；含 # 标题行时套用标题样式 */
export async function plainMarkdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const paras: Paragraph[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const t = line.trimEnd();
    if (t.trim() === '') {
      paras.push(new Paragraph({ text: '' }));
      continue;
    }
    const tr = t.trim();
    if (tr.startsWith('### ')) {
      paras.push(
        new Paragraph({ text: tr.slice(4), heading: HeadingLevel.HEADING_3, spacing: { after: 120 } })
      );
    } else if (tr.startsWith('## ')) {
      paras.push(
        new Paragraph({ text: tr.slice(3), heading: HeadingLevel.HEADING_2, spacing: { after: 120 } })
      );
    } else if (tr.startsWith('# ')) {
      paras.push(
        new Paragraph({ text: tr.slice(2), heading: HeadingLevel.HEADING_1, spacing: { after: 200 } })
      );
    } else {
      paras.push(new Paragraph({ text: t.slice(0, 8000) }));
    }
  }
  if (paras.length === 0) paras.push(new Paragraph({ text: markdown.slice(0, 50_000) }));
  const doc = new Document({ sections: [{ children: paras }] });
  return await Packer.toBuffer(doc);
}
