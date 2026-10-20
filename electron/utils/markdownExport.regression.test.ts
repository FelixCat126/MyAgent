// @vitest-environment node
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToXlsxBuffer, plainMarkdownToDocxBuffer, markdownToHtml } from './markdownExport';

const docXml = async (md: string) => strFromU8(unzipSync(new Uint8Array(await plainMarkdownToDocxBuffer(md)))['word/document.xml']);

describe('文档导出回归', () => {
  it('Excel 长单元格不再让整份导出失败，行高封顶 409', async () => {
    const buf = await markdownToXlsxBuffer('| h | v |\n|---|---|\n| ' + '长'.repeat(1200) + ' | x |\n');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.worksheets[0];
    expect(String(ws.getCell('A2').value)).toHaveLength(1200);
    expect(ws.getRow(2).height).toBe(409);
  });

  it('docx 过滤 XML 非法控制字符', async () => {
    const xml = await docXml('| h | v |\n|---|---|\n| a\u0001b | c\u000bd |\n\n段落\u0008含控制字符');
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false);
    expect(xml).toContain('段落含控制字符');
  });

  it('docx / HTML 表格各行补齐到相同列数', async () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |\n| x |\n';
    const xml = await docXml(md);
    const cells = xml.split('<w:tr>').slice(1).map((r) => (r.match(/<w:tc>/g) || []).length);
    expect(cells).toEqual([4, 4, 4]);
    expect((xml.match(/<w:gridCol /g) || []).length).toBe(4);
    const html = markdownToHtml(md);
    const htmlRows = html.match(/<tr>.*?<\/tr>/g)!.map((r) => (r.match(/<t[hd]>/g) || []).length);
    expect(htmlRows).toEqual([4, 4, 4]);
  });

  it('工作表名以单引号开头时仍可导出', async () => {
    const buf = await markdownToXlsxBuffer("# 'quoted'\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets[0].name.startsWith("'")).toBe(false);
  });
});
