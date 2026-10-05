import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { DocumentFormat } from '../../src/types/document';
import { isDocumentFormat } from '../../src/types/document';
import type { DataCalculationRequest, DataCalculationResult, InspectDocumentRequest, SaveDocumentRequest, WorkbenchDocument } from '../../src/features/documents/types';
import type { FileInfo } from '../../src/types/message';
import { extractTextFromPath } from '../utils/documentText';
import { resolveDataSourcePath } from './dataScope';
import { isAgentPathAllowed } from '../utils/agentPathScope';
import { DocumentVersionRepository, documentMime, type DocumentRecord } from './versions';
import { dataFromTable, executeDataPlan, renderDataChart } from './data';
import { readTable, readWorkbook, scalarCell, tableToText } from './table';
import { renderPdfPage } from './pdf';

type DocumentWriter = (arg: { format: DocumentFormat; content: string; defaultBaseName: string }) => Promise<Buffer>;
const MAX_FILE_SIZE = 80 * 1024 * 1024;
function check(signal?: AbortSignal) { if (signal?.aborted) throw new Error('DOCUMENT_CANCELED'); }
async function readable(filePath: string) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('请使用本地文件完整路径 / Absolute local file path required');
  const real = await fs.realpath(filePath);
  if (!isAgentPathAllowed(real, [])) throw new Error('禁止读取系统目录 / System path access denied');
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error('路径不是文件 / Path is not a file');
  if (stat.size > MAX_FILE_SIZE) throw new Error('文件超过 80MB / File exceeds 80MB');
  return real;
}
function safeName(name: string) { return path.basename(name).replace(/[\\/:"*?<>|\r\n\t]/g, '_').slice(0, 90) || 'document'; }
export class DocumentWorkbenchService {
  readonly repository: DocumentVersionRepository;
  constructor(directory: string, private readonly outputDirectory: string, private readonly writer: DocumentWriter) { this.repository = new DocumentVersionRepository(directory); }
  private async view(record: DocumentRecord, options: Pick<InspectDocumentRequest, 'sheet' | 'range' | 'ocr'> = {}, signal?: AbortSignal): Promise<WorkbenchDocument> {
    const version = record.versions.find((v) => v.id === record.activeVersionId);
    if (!version) throw new Error('活动版本不存在 / Active version missing');
    await readable(version.file.path); check(signal);
    const kind = version.format;
    const tableKind = ['xlsx', 'xlsm', 'csv'].includes(kind);
    const table = tableKind ? await readTable(version.file.path, { sheet: options.sheet, range: options.range }) : undefined;
    const extracted = !table && (kind === 'pdf' || /^png|jpe?g|webp|bmp|tiff?$/.test(kind)) ? await extractTextFromPath(version.file.path, version.file.name, { signal, ocr: options.ocr }) : undefined;
    return { id: record.id, sourcePath: record.sourcePath, sourceMissing: !(await fs.stat(record.sourcePath).then(() => true).catch(() => false)), title: record.title, kind, content: table ? tableToText(table.table) : extracted?.text ?? version.content ?? '', editable: ['md', 'markdown', 'txt', 'docx', 'pdf', 'xlsx', 'csv'].includes(kind) && (tableKind || !(extracted?.truncated || version.truncated)), editNotice: ['pdf', 'docx'].includes(kind) ? '编辑提取的正文；导出将重新排版，原文件保持不变。 / Edit extracted text; export reflows layout and preserves the original.' : undefined, pages: extracted?.pages, table: table?.table, sheets: table?.sheets, versions: record.versions, activeVersionId: record.activeVersionId, truncated: table?.table.truncated || extracted?.truncated || version.truncated };
  }
  async inspect(arg: InspectDocumentRequest, signal?: AbortSignal): Promise<WorkbenchDocument> {
    check(signal);
    const previous = await this.repository.findByPath(arg.path);
    let source: string;
    try { source = await readable(arg.path); }
    catch (e) { if (previous) return this.view(previous, arg, signal); throw e; }
    if (previous && previous.versions.some((v) => v.file.path === arg.path)) return this.view({ ...previous, activeVersionId: previous.versions.find((v) => v.file.path === arg.path)!.id }, arg, signal);
    if (previous && createHash('sha256').update(await fs.readFile(source)).digest('hex') === previous.hash) return this.view(previous, arg, signal);
    // Verify the source is stable across extraction before capturing its immutable snapshot.
    const expectedHash = createHash('sha256').update(await fs.readFile(source)).digest('hex');
    const extracted = await extractTextFromPath(source, arg.name, { ...arg, signal }); check(signal);
    if (['unsupported', 'doc-legacy', 'xls-legacy'].includes(extracted.kind)) throw new Error(extracted.text);
    const record = await this.repository.capture(path.resolve(arg.path), extracted.kind, extracted.text, { truncated: extracted.truncated, expectedHash }); check(signal);
    if (record.activeVersionId !== record.versions[record.versions.length - 1].id && previous) return this.view(record, arg, signal);
    // PDF inspection already rendered/read all pages; reuse its result instead of running OCR twice.
    if (extracted.pages) return { id: record.id, sourcePath: record.sourcePath, sourceMissing: false, title: record.title, kind: extracted.kind, content: extracted.text, pages: extracted.pages, truncated: extracted.truncated, editable: extracted.kind === 'pdf' && !extracted.truncated, editNotice: '编辑提取正文并重新排版；原文件保持不变。 / Edits reflow the extracted text; original preserved.', versions: record.versions, activeVersionId: record.activeVersionId };
    return this.view(record, arg, signal);
  }
  async renderPage(arg: { path: string; page: number }, signal?: AbortSignal) { return renderPdfPage(await readable(arg.path), arg.page, signal); }
  async save(arg: SaveDocumentRequest, signal?: AbortSignal): Promise<{ document: WorkbenchDocument; files: FileInfo[] }> {
    const record = await this.repository.get(arg.documentId); const base = record.versions.find((v) => v.id === arg.baseVersionId);
    if (!base || record.activeVersionId !== arg.baseVersionId) throw new Error('编辑版本已过期，请重新打开 / Edit version is stale; reopen');
    if (arg.content !== undefined && (typeof arg.content !== 'string' || Buffer.byteLength(arg.content) > 12 * 1024 * 1024)) throw new Error('正文过大 / Content exceeds 12MB');
    await readable(base.file.path); check(signal);
    const id = randomUUID(); const dir = path.join(this.repository.directory, record.id); await fs.mkdir(dir, { recursive: true });
    const files: FileInfo[] = []; let content = arg.content ?? base.content ?? ''; let mainFormat: DocumentFormat;
    let committed = false;
    try {
      let spreadsheet: Buffer | undefined;
      if (arg.cells) {
        if (!['xlsx', 'csv'].includes(base.format) || !Array.isArray(arg.cells) || arg.cells.length > 2000) throw new Error('只能修改 XLSX/CSV，单次最多 2000 单元格 / Invalid cell edit request');
        const workbook = await readWorkbook(base.file.path);
        for (const edit of arg.cells) {
          check(signal);
          if (!edit || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(edit.address) || (typeof edit.value !== 'string' && typeof edit.value !== 'number' && typeof edit.value !== 'boolean' && edit.value !== null)) throw new Error('无效单元格修改 / Invalid cell edit');
          const sheet = workbook.getWorksheet(edit.sheet); if (!sheet) throw new Error('工作表不存在 / Worksheet missing');
          const cell = sheet.getCell(edit.address); if (Number(cell.row) > 1_048_576 || Number(cell.col) > 16_384) throw new Error('单元格越界 / Cell out of range'); cell.value = edit.value;
        }
        spreadsheet = Buffer.from(await workbook.xlsx.writeBuffer()); mainFormat = 'xlsx';
      } else { mainFormat = ['xlsx', 'csv'].includes(base.format) ? 'xlsx' : base.format === 'txt' ? 'txt' : ['docx', 'pdf'].includes(base.format) ? 'docx' : 'md'; }
      const formats = [...new Set(arg.formats?.length ? arg.formats : [mainFormat])];
      if (formats.length > 3 || !formats.every(isDocumentFormat)) throw new Error('单次最多导出 3 种支持的格式 / Choose at most three supported formats');
      if (spreadsheet && formats.some((f) => f !== 'xlsx' && f !== 'csv')) throw new Error('表格编辑支持 Excel 和 CSV 双格式 / Table edits export as XLSX/CSV');
      if (spreadsheet && !formats.includes('xlsx')) formats.unshift('xlsx');
      for (const format of formats) {
        check(signal); let buffer: Buffer;
        if (spreadsheet && format === 'xlsx') buffer = spreadsheet;
        else if (spreadsheet && format === 'csv') {
          const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(spreadsheet.buffer.slice(spreadsheet.byteOffset, spreadsheet.byteOffset + spreadsheet.byteLength) as ArrayBuffer);
          if (workbook.worksheets.length !== 1) throw new Error('多工作表不能完整导出 CSV，请只选 XLSX / Multiple sheets require XLSX');
          const rows: unknown[][] = []; const worksheet = workbook.worksheets[0];
          if (worksheet.rowCount > 10_001 || worksheet.columnCount > 100) throw new Error('CSV 导出数据过大，请仅导出 XLSX / CSV range too large; use XLSX');
          const warnings = new Set<string>();
          for (let row = 1; row <= worksheet.rowCount; row++) rows.push(Array.from({ length: worksheet.columnCount }, (_, i) => scalarCell(worksheet.getCell(row, i + 1), warnings)));
          buffer = Buffer.from('\uFEFF' + rows.map((r) => r.map((v) => { const raw = String(v ?? ''); const safe = /^\s*[=+@-]/.test(raw) && typeof v !== 'number' ? "'" + raw : raw; return '"' + safe.replace(/"/g, '""') + '"'; }).join(',')).join('\r\n'));
        } else buffer = await this.writer({ format, content, defaultBaseName: record.title });
        check(signal); const target = path.join(dir, `${id}.${format}`); await fs.writeFile(target, buffer, { mode: 0o600 }); files.push({ path: target, name: `${safeName(path.parse(record.title).name)}-v${record.versions.length + 1}.${format}`, size: buffer.length, type: documentMime(format) });
      }
      const file = files.find((f) => f.path.endsWith(`.${mainFormat}`)) ?? files[0];
      mainFormat = path.extname(file.path).slice(1) as DocumentFormat;
      if (spreadsheet) content = tableToText((await readTable(file.path)).table);
      const next: DocumentRecord = { ...record, activeVersionId: id, versions: [...record.versions, { id, parentId: base.id, createdAt: Date.now(), label: arg.label?.trim().slice(0, 100) || `版本 ${record.versions.length + 1} / Version ${record.versions.length + 1}`, format: mainFormat, file, exports: files, content }] };
      check(signal); await this.repository.write(next, base.id); committed = true;
      return { document: await this.view(next, {}, signal), files };
    } catch (e) { if (!committed) await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {}))); throw e; }
  }
  async restore(arg: { documentId: string; versionId: string }, signal?: AbortSignal) {
    const record = await this.repository.get(arg.documentId); const source = record.versions.find((v) => v.id === arg.versionId);
    if (!source) throw new Error('恢复版本不存在 / Restore version missing');
    await readable(source.file.path); check(signal);
    const bytes = await fs.readFile(source.file.path); const id = randomUUID(); const target = path.join(this.repository.directory, record.id, `${id}.${source.format}`);
    await fs.writeFile(target, bytes, { mode: 0o600 });
    const file = { ...source.file, path: target, name: `${path.parse(record.title).name}-restored-v${record.versions.length + 1}.${source.format}` };
    const next = { ...record, activeVersionId: id, versions: [...record.versions, { ...source, id, parentId: record.activeVersionId, createdAt: Date.now(), label: `恢复 / Restore: ${source.label}`, file }] };
    try { check(signal); await this.repository.write(next, record.activeVersionId); }
    catch (e) { await fs.unlink(target).catch(() => {}); throw e; }
    return { document: await this.view(next, {}, signal), files: [file] };
  }
  async compare(arg: { documentId: string; leftId: string; rightId: string }) {
    const record = await this.repository.get(arg.documentId); const left = record.versions.find((v) => v.id === arg.leftId), right = record.versions.find((v) => v.id === arg.rightId);
    if (!left || !right) throw new Error('比较版本不存在 / Compare version missing');
    return { left: left.content ?? '', right: right.content ?? '', leftLabel: left.label, rightLabel: right.label };
  }
  async calculate(arg: DataCalculationRequest, signal?: AbortSignal): Promise<DataCalculationResult> {
    const sourcePath = await readable(await resolveDataSourcePath(arg.path,arg.scope)); check(signal);
    const before = await fs.stat(sourcePath, { bigint: true });
    const { table } = await readTable(sourcePath, { sheet: arg.sheet, range: arg.range, maxRows: 10_001, strict: true });
    const after = await fs.stat(sourcePath, { bigint: true }).catch(() => null); check(signal);
    if (!after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('读取数据时源文件发生变化，请重新执行 / Source file changed during data read; retry');
    if (table.truncated) throw new Error('数据被截断，不能据此计算，请指定完整范围 / Truncated input; specify a complete range');
    const data = executeDataPlan(dataFromTable(table), arg.steps, signal); const chartSvg = arg.chart ? renderDataChart(data, arg.chart) : undefined;
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Result'); sheet.addRow(data.columns); data.rows.forEach((r) => sheet.addRow(data.columns.map((c) => r[c])));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.columns.forEach((c) => { c.width = 22; });
    const source = { path: sourcePath, sheet: table.sheet, range: table.range }; const audit = workbook.addWorksheet('Source'); audit.addRows([['Source file', source.path], ['Sheet', source.sheet], ['Range', source.range], ['Plan', JSON.stringify(arg.steps)], ...data.warnings.map((w) => ['Warning', w])]);
    const csv = '\uFEFF' + [data.columns, ...data.rows.map((r) => data.columns.map((c) => r[c]))].map((r) => r.map((v) => { const text = String(v ?? ''); const safe = /^\s*[=+@-]/.test(text) && typeof v !== 'number' ? "'" + text : text; return '"' + safe.replace(/"/g, '""') + '"'; }).join(',')).join('\r\n');
    const id = randomUUID(); const dir = path.join(this.outputDirectory, id); await fs.mkdir(dir, { recursive: true }); const files: FileInfo[] = [];
    const outputs: [string, Buffer][] = [['result.xlsx', Buffer.from(await workbook.xlsx.writeBuffer())], ['result.csv', Buffer.from(csv)], ['calculation.json', Buffer.from(JSON.stringify({ ...data, source, steps: arg.steps }, null, 2))]];
    if (chartSvg) outputs.push(['chart.svg', Buffer.from(chartSvg)]);
    try { for (const [name, bytes] of outputs) { check(signal); const target = path.join(dir, name); await fs.writeFile(target, bytes, { mode: 0o600 }); files.push({ path: target, name, type: documentMime(path.extname(name).slice(1)), size: bytes.length }); } }
    catch (e) { await fs.rm(dir, { recursive: true, force: true }); throw e; }
    return { ...data, source, files, chartSvg };
  }
}
