import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToCsv, markdownToXlsxBuffer, plainMarkdownToDocxBuffer, markdownToHtml, parseMarkdownTables } from './markdownExport';
const md = '# 月度经营报告\n\n本月**收入**稳步增长。\n\n## 经营数据\n\n| 编号 | 金额 | 增长率 | 备注 |\n|---|---:|---:|---|\n| 0012 | 123.50 | 12.5% | 合同\\|续签 |\n| 0089 | -20 | 0% | =SUM(A1:A2) |\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```';
describe('document rendering', () => {
  it('parses escaped table cells and retains headings as sheet names', () => {
    const t = parseMarkdownTables(md)[0];
    expect(t.name).toBe('经营数据'); expect(t.rows[1][3]).toBe('合同|续签');
  });
  it('creates styled Excel with numeric cells and text identifiers', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await markdownToXlsxBuffer(md) as never);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A2').value).toBe('0012'); expect(ws.getCell('B2').value).toBe(123.5);
    expect(ws.getCell('C2').value).toBe(0.125); expect(ws.getCell('C2').numFmt).toBe('0.00%');
    expect(ws.getCell('D3').value).toBe('=SUM(A1:A2)'); expect(ws.views[0].state).toBe('frozen');
    expect(ws.getRow(1).height).toBe(30); expect(ws.autoFilter).toBeTruthy();
  });
  it('rejects non-table spreadsheets instead of pretending to export successfully', async () => {
    await expect(markdownToXlsxBuffer('没有表格')).rejects.toThrow('表格');
    expect(() => markdownToCsv('没有表格')).toThrow('表格');
  });
  it('CSV protects formula-like text and refuses to silently discard extra tables', () => {
    expect(markdownToCsv(md)).toContain("'=SUM(A1:A2)");
    expect(() => markdownToCsv(md + '\n\n' + md)).toThrow('一张表');
  });
  it('Word includes real tables, styles, footer and untruncated body', async () => {
    const long = '长'.repeat(9000);
    const zip = unzipSync(await plainMarkdownToDocxBuffer(md + '\n\n' + long));
    const xml = strFromU8(zip['word/document.xml']);
    expect(xml).toContain('<w:tbl>'); expect(xml).toContain('w:tblHeader'); expect(xml).toContain(long);
    expect(xml).not.toContain('**收入**'); expect(xml).toContain('Title');
    expect(strFromU8(zip['word/footer1.xml'])).toContain('PAGE');
  });
  it('PDF HTML preserves formatting and prevents active content or remote resources', () => {
    const html = markdownToHtml(md + '\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)');
    expect(html).toContain('<strong>收入</strong>'); expect(html).toContain('<thead>');
    expect(html).toContain('table-header-group'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:'); expect(html).toContain("default-src 'none'");
  });
});

describe('parseMarkdownTables', () => {
  it('解析最基本的 GFM 管道表格', () => {
    const md = `# 标题\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 5 |\n`;
    const tables = parseMarkdownTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe('标题');
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
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Table1 1', 'Table2 2']);
    const s1 = wb.getWorksheet('Table1 1')!;
    expect(s1.getCell(1, 1).value).toBe('列1');
    expect(s1.getCell(3, 2).value).toBe(2);
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

it('recognizes grouped numeric amounts without converting identifier columns', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await markdownToXlsxBuffer('| 编号 | 金额 |\n|---|---|\n|0012|1,200.50|') as never);
  expect(wb.worksheets[0].getCell('A2').value).toBe('0012');
  expect(wb.worksheets[0].getCell('B2').value).toBe(1200.5);
  expect(wb.worksheets[0].getCell('B2').numFmt).toBe('0.00');
});
