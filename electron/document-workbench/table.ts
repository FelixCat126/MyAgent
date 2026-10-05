import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { DataScalar, TableCell, TablePreview } from '../../src/features/documents/types';

export const MAX_DATA_ROWS = 10_000;
export const MAX_DATA_COLS = 100;
export function columnName(number: number): string {
  let name = ''; for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name;
}
function columnNumber(value: string): number { return [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }
export function parseRange(range: string, rowCount: number, columnCount: number) {
  const m = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/i.exec(range);
  if (!m) throw new Error('范围格式应为 A1:D100 / Expected range A1:D100');
  const startCol = columnNumber(m[1].toUpperCase()), endCol = columnNumber(m[3].toUpperCase());
  const startRow = Number(m[2]), endRow = Number(m[4]);
  if (endCol < startCol || endRow < startRow || endCol > 16_384 || endRow > 1_048_576) throw new Error('无效范围 / Invalid range');
  if (endCol - startCol + 1 > MAX_DATA_COLS || endRow - startRow > MAX_DATA_ROWS) throw new Error('数据范围过大，最多 100 列、10,000 数据行 / Range exceeds 100 columns or 10,000 data rows');
  if (startRow > rowCount || startCol > columnCount) throw new Error('范围未命中数据 / Range contains no data');
  return { startRow, endRow: Math.min(endRow, rowCount), startCol, endCol: Math.min(endCol, columnCount) };
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"' && !cell) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
    if (rows.length > MAX_DATA_ROWS + 1 || row.length > MAX_DATA_COLS) throw new Error('CSV 过大，请指定更小的数据文件 / CSV exceeds data limits');
  }
  if (quoted) throw new Error('CSV 引号未闭合 / Unclosed CSV quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.some((r) => r.length > MAX_DATA_COLS)) throw new Error('CSV 超过 100 列 / CSV exceeds 100 columns');
  return rows;
}
export function scalarCell(cell: ExcelJS.Cell, warnings: Set<string>): DataScalar {
  const value = cell.value;
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined) { warnings.add(`未计算公式 / Formula has no cached result: ${cell.address}`); return null; }
    if (typeof value.result === 'object') { warnings.add(`公式错误 / Formula error: ${cell.address}`); return null; }
    return value.result as DataScalar;
  }
  if ('text' in value) return value.text;
  if ('error' in value) { warnings.add(`单元格错误 / Cell error: ${cell.address} ${value.error}`); return null; }
  return String(value);
}
export async function readWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filePath)) {
    const rows = parseCsv(await fs.readFile(filePath, 'utf8'));
    const sheet = workbook.addWorksheet('CSV'); rows.forEach((r) => sheet.addRow(r));
  } else if (/\.(xlsx|xlsm)$/i.test(filePath)) {
    const bytes = await fs.readFile(filePath);
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } else throw new Error(`不支持的数据格式 / Unsupported data format: ${path.extname(filePath)}`);
  return workbook;
}
export async function readTable(filePath: string, options: { sheet?: string; range?: string; maxRows?: number; strict?: boolean } = {}): Promise<{ table: TablePreview; sheets: string[] }> {
  const workbook = await readWorkbook(filePath);
  const sheet = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0];
  if (!sheet) throw new Error('未找到指定工作表 / Worksheet not found');
  if (!sheet.rowCount || !sheet.columnCount) return { table: { sheet: sheet.name, range: 'A1:A1', columns: [], rows: [], totalRows: 0, truncated: false, warnings: [] }, sheets: workbook.worksheets.map((s) => s.name) };
  if (!options.range && options.strict && (sheet.rowCount > MAX_DATA_ROWS + 1 || sheet.columnCount > MAX_DATA_COLS)) throw new Error('工作表过大，请指定 sheet 与 range（最多 10,000 行、100 列） / Specify a smaller sheet range');
  const bounds = parseRange(options.range || `A1:${columnName(Math.min(sheet.columnCount, MAX_DATA_COLS))}${Math.min(sheet.rowCount, MAX_DATA_ROWS + 1)}`, sheet.rowCount, sheet.columnCount);
  const maxRows = Math.min(options.maxRows ?? 500, MAX_DATA_ROWS + 1);
  const rows: TableCell[][] = []; const warnings = new Set<string>();
  for (let row = bounds.startRow; row <= Math.min(bounds.endRow, bounds.startRow + maxRows - 1); row++) {
    const cells: TableCell[] = [];
    for (let col = bounds.startCol; col <= bounds.endCol; col++) {
      const cell = sheet.getCell(row, col);
      const formula = cell.formula;
      cells.push({ address: cell.address, value: scalarCell(cell, warnings), ...(formula ? { formula } : {}) });
    }
    rows.push(cells);
  }
  return { table: { sheet: sheet.name, range: `${columnName(bounds.startCol)}${bounds.startRow}:${columnName(bounds.endCol)}${bounds.endRow}`, columns: Array.from({ length: bounds.endCol - bounds.startCol + 1 }, (_, i) => columnName(i + bounds.startCol)), rows, totalRows: bounds.endRow - bounds.startRow + 1, truncated: bounds.endRow - bounds.startRow + 1 > maxRows || (!options.range && (sheet.columnCount > MAX_DATA_COLS || sheet.rowCount > MAX_DATA_ROWS + 1)), warnings: [...warnings] }, sheets: workbook.worksheets.map((s) => s.name) };
}
export function tableToText(table: TablePreview): string {
  const parts = [`### 工作表 / Sheet: ${table.sheet} (${table.range})`, '| 行 / Row | ' + table.columns.join(' | ') + ' |', '| --- | ' + table.columns.map(() => '---').join(' | ') + ' |'];
  for (const cells of table.rows) parts.push('| ' + [cells[0]?.address.match(/\d+/)?.[0] ?? '', ...cells.map((c) => String(c.value ?? '').replace(/\|/g, '｜').replace(/\r?\n/g, ' '))].join(' | ') + ' |');
  if (table.truncated) parts.push('（仅显示部分数据 / Partial range shown）');
  if (table.warnings.length) parts.push(...table.warnings);
  return parts.join('\n');
}
