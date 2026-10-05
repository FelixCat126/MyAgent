// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { DocumentWorkbenchService } from './service';
import * as tableReader from './table';
let dir: string;
const createService = () => new DocumentWorkbenchService(path.join(dir, 'versions'), path.join(dir, 'results'), async (arg) => Buffer.from(arg.content));
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-workbench-')); });
afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });
describe('document workbench persistence and calculation', () => {
  it('saves distinct versions, persists after restart, compares and restores while retaining originals', async () => {
    const source = path.join(dir, 'report.md'); await fs.writeFile(source, '# Original\n\nRevenue 10');
    const service = createService(); const doc = await service.inspect({ path: source });
    const saved = await service.save({ documentId: doc.id, baseVersionId: doc.activeVersionId, content: '# Revised\n\nRevenue 15', formats: ['md'] });
    expect(await fs.readFile(source, 'utf8')).toContain('Revenue 10'); expect(saved.document.content).toContain('Revenue 15');
    const restarted = createService(); const reopened = await restarted.inspect({ path: source }); expect(reopened.content).toContain('Revenue 15');
    const compared = await restarted.compare({ documentId: doc.id, leftId: doc.activeVersionId, rightId: reopened.activeVersionId }); expect(compared.left).toContain('10'); expect(compared.right).toContain('15');
    const restored = await restarted.restore({ documentId: doc.id, versionId: doc.activeVersionId }); expect(restored.document.content).toContain('10'); expect(restored.document.versions).toHaveLength(3);
    expect(await fs.readFile(saved.files[0].path, 'utf8')).toContain('15');
  });
  it('can read a retained version after source deletion and clearly marks it missing', async () => {
    const source = path.join(dir, 'a.txt'); await fs.writeFile(source, 'preserved'); const service = createService(); await service.inspect({ path: source }); await fs.unlink(source);
    const reopened = await service.inspect({ path: source }); expect(reopened.sourceMissing).toBe(true); expect(reopened.content).toBe('preserved');
  });
  it('rejects stale edits and preserves completed files on canceled previews', async () => {
    const source = path.join(dir, 'a.md'); await fs.writeFile(source, 'original'); const service = createService(); const doc = await service.inspect({ path: source });
    await service.save({ documentId: doc.id, baseVersionId: doc.activeVersionId, content: 'one' });
    await expect(service.save({ documentId: doc.id, baseVersionId: doc.activeVersionId, content: 'two' })).rejects.toThrow(/stale/);
    const controller = new AbortController(); controller.abort(); await expect(service.inspect({ path: source }, controller.signal)).rejects.toThrow('DOCUMENT_CANCELED');
  });
  it('reads exact sheet/range with cell citations, edits one cell, and executes real grouped sums with chart and downloads', async () => {
    const source = path.join(dir, 'data.xlsx'); const wb = new ExcelJS.Workbook(); wb.addWorksheet('Other').addRow(['untouched']); const sh = wb.addWorksheet('Sales'); sh.addRows([['Region', 'Revenue'], ['East', 10], ['West', 20], ['East', 5]]); await wb.xlsx.writeFile(source);
    const service = createService(); const doc = await service.inspect({ path: source, sheet: 'Sales', range: 'A1:B4' }); expect(doc.table?.rows[2][1]).toEqual({ address: 'B3', value: 20 });
    const saved = await service.save({ documentId: doc.id, baseVersionId: doc.activeVersionId, cells: [{ sheet: 'Sales', address: 'B2', value: 12 }], formats: ['xlsx'] });
    const result = await service.calculate({ path: saved.files[0].path, sheet: 'Sales', range: 'A1:B4', steps: [{ op: 'group', by: ['Region'], aggregates: [{ column: 'Revenue', function: 'sum', as: 'Total' }] }], chart: { type: 'bar', x: 'Region', y: 'Total' } });
    expect(result.rows).toEqual([{ Region: 'East', Total: 17 }, { Region: 'West', Total: 20 }]); expect(result.source.range).toBe('A1:B4'); expect(result.files).toHaveLength(4); expect(result.chartSvg).toContain('East');
    const output = new ExcelJS.Workbook(); await output.xlsx.readFile(result.files[0].path); expect(output.getWorksheet('Result')?.getCell('B2').value).toBe(17); expect(output.getWorksheet('Source')?.getCell('B3').value).toBe('A1:B4');
    const original = new ExcelJS.Workbook(); await original.xlsx.readFile(source); expect(original.getWorksheet('Sales')?.getCell('B2').value).toBe(10);
  });
  it('reports formula-without-result instead of manufacturing a numeric answer', async () => {
    const source = path.join(dir, 'formula.xlsx'); const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('S'); sheet.addRow(['Name', 'Amount']); sheet.addRow(['A', { formula: '2+2' }]); await wb.xlsx.writeFile(source);
    const result = await createService().calculate({ path: source, steps: [{ op: 'group', by: ['Name'], aggregates: [{ column: 'Amount', function: 'sum', as: 'Total' }] }] }); expect(result.rows[0].Total).toBeNull(); expect(result.warnings.join(' ')).toContain('cached result');
  });
  it('exports exact monetary totals into actual XLSX, CSV and JSON result files', async () => {
    const source = path.join(dir, 'money.csv'); await fs.writeFile(source, 'Category,Amount\nSale,0.1\nSale,0.2\n');
    const result = await createService().calculate({ path: source, steps: [{ op: 'group', by: ['Category'], aggregates: [{ column: 'Amount', function: 'sum', as: 'Total' }] }] });
    expect(result.rows[0].Total).toBe(.3); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(result.files.find(f => f.name === 'result.xlsx')!.path); expect(workbook.getWorksheet('Result')?.getCell('B2').value).toBe(.3);
    expect(await fs.readFile(result.files.find(f => f.name === 'result.csv')!.path, 'utf8')).toContain('"0.3"'); expect(JSON.parse(await fs.readFile(result.files.find(f => f.name === 'calculation.json')!.path, 'utf8')).rows[0].Total).toBe(.3);
  });
  it('rejects a source changed during reading before creating result files', async () => {
    const source = path.join(dir, 'changing.csv'); await fs.writeFile(source, 'Name,Amount\nA,10\n'); const actualRead = tableReader.readTable;
    const read = vi.spyOn(tableReader, 'readTable').mockImplementationOnce(async (...args) => { const table = await actualRead(...args); await fs.writeFile(source, 'Name,Amount\nA,99\n'); return table; });
    try { await expect(createService().calculate({ path: source, steps: [] })).rejects.toThrow(/Source file changed/); await expect(fs.stat(path.join(dir, 'results'))).rejects.toThrow(); }
    finally { read.mockRestore(); }
  });
});
