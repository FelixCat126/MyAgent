// @vitest-environment node
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  markdownToXlsxBuffer,
  parseMarkdownTables,
  plainMarkdownToDocxBuffer,
} from './markdownExport';

describe('parseMarkdownTables', () => {
  it('解析最基本的 GFM 管道表格', () => {
    const md = `# 标题\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 5 |\n`;
    const tables = parseMarkdownTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe('Table1');
    expect(tables[0]!.rows).toEqual([
      ['名称', '数量'],
      ['苹果', '3'],
      ['梨', '5'],
    ]);
  });

  it('多张表分别编号；行宽不齐自动补齐', () => {
    const md = `
| a | b | c |
| --- | --- | --- |
| 1 | 2 |
| 3 | 4 | 5 |

正文夹杂。

| x | y |
| --- | --- |
| u | v |
`;
    const tables = parseMarkdownTables(md);
    expect(tables.map((t) => t.name)).toEqual(['Table1', 'Table2']);
    expect(tables[0]!.rows[1]).toEqual(['1', '2', '']);
    expect(tables[1]!.rows).toEqual([
      ['x', 'y'],
      ['u', 'v'],
    ]);
  });

  it('没有分隔符行不视作表格', () => {
    const md = `| a | b |\n| 1 | 2 |\n`;
    expect(parseMarkdownTables(md)).toEqual([]);
  });

  it('无管道时不识别', () => {
    expect(parseMarkdownTables('普通段落，无表格。')).toEqual([]);
  });
});

describe('markdownToXlsxBuffer', () => {
  it('有表格时按表分 sheet 写入', async () => {
    const md = [
      '| 列1 | 列2 |',
      '| --- | --- |',
      '| a | 1 |',
      '| b | 2 |',
      '',
      '| 名称 | 备注 |',
      '| --- | --- |',
      '| 仅 | 测试 |',
      '',
    ].join('\n');
    const buf = await markdownToXlsxBuffer(md);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Table1', 'Table2']);
    const s1 = wb.getWorksheet('Table1')!;
    expect(s1.getCell(1, 1).value).toBe('列1');
    expect(s1.getCell(3, 2).value).toBe('2');
  });

  it('无表格时写一张 Content 占位', async () => {
    const buf = await markdownToXlsxBuffer('没有任何管道表格的纯文本。');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets[0].name).toBe('Content');
    expect(String(wb.worksheets[0].getCell(1, 1).value)).toMatch(/未识别到 Markdown 管道表格/);
  });
});

describe('plainMarkdownToDocxBuffer', () => {
  it('返回非空 Buffer 且以 PK 开头（docx 即 zip）', async () => {
    const buf = await plainMarkdownToDocxBuffer('# 一级\n\n## 二级\n\n### 三级\n\n正文段落');
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.slice(0, 2).toString('binary')).toBe('PK');
  });

  it('空字符串也能生成可解析 docx', async () => {
    const buf = await plainMarkdownToDocxBuffer('');
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.slice(0, 2).toString('binary')).toBe('PK');
  });
});
