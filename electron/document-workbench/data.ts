import type { DataScalar, DataStep, TablePreview } from '../../src/features/documents/types';
import Decimal from 'decimal.js';
export type DataSet = { columns: string[]; rows: Record<string, DataScalar>[]; warnings: string[] };
// Keep decimal arithmetic local; changing Decimal's global precision would affect other features.
const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
function decimal(value: DataScalar, column: string): Decimal {
  const literal = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' && /^-?(?:\d+(?:,\d{3})*|\d*)(?:\.\d+)?$/.test(value.trim()) && value.trim() ? value.trim().replace(/,/g, '') : undefined;
  if (literal === undefined) throw new Error(`非数值数据 / Non-numeric value in ${column}: ${String(value).slice(0, 60)}`);
  const result = new Exact(literal);
  if (!result.isFinite() || (result.isInteger() && result.abs().gt(Number.MAX_SAFE_INTEGER))) throw new Error(`数值超过安全整数范围 / Unsafe integer exceeds numeric range in ${column}`);
  return result;
}
function outputNumber(value: Decimal): number { const result = value.toNumber(); if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) throw new Error('计算结果超出安全数值范围 / Calculation exceeds numeric range'); return result; }
function numeric(value: DataScalar, column: string): number { return outputNumber(decimal(value, column)); }
function exists(columns: string[], name: string): void { if (!columns.includes(name)) throw new Error(`未找到列 / Column not found: ${name}`); }
export function dataFromTable(table: TablePreview): DataSet {
  if (!table.rows.length) throw new Error('数据为空 / Empty data');
  const columns = table.rows[0].map((c, i) => String(c.value ?? '').trim() || table.columns[i]);
  if (new Set(columns).size !== columns.length) throw new Error('表头重复，请先修改列名 / Duplicate column headers');
  const rows = table.rows.slice(1).filter((r) => r.some((c) => c.value !== null && c.value !== '')).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]?.value ?? null])));
  return { columns, rows, warnings: [...table.warnings] };
}
export function executeDataPlan(input: DataSet, steps: DataStep[], signal?: AbortSignal): DataSet {
  if (!Array.isArray(steps) || steps.length > 20) throw new Error('最多执行 20 个数据步骤 / At most 20 data steps');
  let columns = [...input.columns], rows = input.rows.map((r) => ({ ...r })); const warnings = [...input.warnings];
  for (const step of steps) {
    if (signal?.aborted) throw new Error('DOCUMENT_CANCELED');
    if (!step || typeof step !== 'object') throw new Error('无效数据步骤 / Invalid data step');
    switch (step.op) {
      case 'filter': {
        exists(columns, step.column);
        if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'].includes(step.operator)) throw new Error('无效筛选运算符 / Invalid filter operator');
        rows = rows.filter((r) => {
          const value = r[step.column];
          if (step.operator === 'eq') return value === step.value || String(value) === String(step.value);
          if (step.operator === 'ne') return !(value === step.value || String(value) === String(step.value));
          if (step.operator === 'contains') return String(value ?? '').includes(String(step.value ?? ''));
          if (value == null || value === '') return false;
          const comparison = decimal(value, step.column).cmp(decimal(step.value, step.column));
          return step.operator === 'gt' ? comparison > 0 : step.operator === 'gte' ? comparison >= 0 : step.operator === 'lt' ? comparison < 0 : comparison <= 0;
        }); break;
      }
      case 'select': {
        if (!Array.isArray(step.columns) || !step.columns.length || new Set(step.columns).size !== step.columns.length) throw new Error('无效选列 / Invalid selected columns');
        step.columns.forEach((c) => exists(columns, c)); columns = [...step.columns]; rows = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))); break;
      }
      case 'dedupe': {
        const keys = step.columns ?? columns; if (!Array.isArray(keys) || !keys.length) throw new Error('去重列不能为空 / Dedupe keys cannot be empty'); keys.forEach((c) => exists(columns, c));
        const seen = new Set<string>(); rows = rows.filter((r) => { const key = JSON.stringify(keys.map((c) => r[c])); if (seen.has(key)) return false; seen.add(key); return true; }); break;
      }
      case 'group': {
        if (!Array.isArray(step.by) || !Array.isArray(step.aggregates) || !step.aggregates.length) throw new Error('无效分组 / Invalid group plan');
        step.by.forEach((c) => exists(columns, c));
        const nextColumns = [...step.by, ...step.aggregates.map((a) => a.as)];
        if (new Set(nextColumns).size !== nextColumns.length || nextColumns.some((c) => typeof c !== 'string' || !c || c.length > 100)) throw new Error('汇总列名不能为空或重复 / Invalid aggregate names');
        for (const a of step.aggregates) { if (!['sum', 'avg', 'count', 'min', 'max'].includes(a.function)) throw new Error('无效聚合 / Invalid aggregate'); if (a.function !== 'count') exists(columns, a.column ?? ''); }
        const groups = new Map<string, typeof rows>();
        for (const row of rows) { const key = JSON.stringify(step.by.map((c) => row[c])); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
        rows = [...groups.values()].map((group) => {
          const row: Record<string, DataScalar> = Object.assign(Object.create(null), Object.fromEntries(step.by.map((c) => [c, group[0][c]])));
          for (const a of step.aggregates) {
            if (a.function === 'count') { row[a.as] = group.length; continue; }
            const values = group.map((r) => r[a.column!]).filter((v) => v !== null && v !== '').map((v) => decimal(v, a.column!));
            if (values.length < group.length) warnings.push(`汇总忽略 ${group.length - values.length} 个空值 / Blank values skipped: ${a.column}`);
            const total = values.reduce((n, v) => n.plus(v), new Exact(0));
            row[a.as] = !values.length ? null : outputNumber(a.function === 'sum' ? total : a.function === 'avg' ? total.div(values.length) : values.reduce((chosen, v) => (a.function === 'min' ? v.lt(chosen) : v.gt(chosen)) ? v : chosen));
          } return row;
        }); columns = nextColumns; break;
      }
      case 'yoy': {
        exists(columns, step.yearColumn); exists(columns, step.valueColumn); const keys = step.by ?? []; keys.forEach((c) => exists(columns, c)); const name = step.as ?? 'YoY';
        if (columns.includes(name)) throw new Error('同比列名已存在 / YoY column already exists');
        const index = new Map<string, Decimal>();
        for (const row of rows) { const year = numeric(row[step.yearColumn], step.yearColumn); if (!Number.isInteger(year)) throw new Error('同比年份必须为整数 / YoY year must be an integer'); const key = JSON.stringify([...keys.map((c) => row[c]), year]); if (index.has(key)) throw new Error('同比数据每组每年必须唯一，先执行分组 / Group by year before YoY'); index.set(key, decimal(row[step.valueColumn], step.valueColumn)); }
        rows = rows.map((r) => { const prior = index.get(JSON.stringify([...keys.map((c) => r[c]), numeric(r[step.yearColumn], step.yearColumn) - 1])); if (prior === undefined || prior.isZero()) { warnings.push(`同比无有效基期 / No valid YoY baseline: ${String(r[step.yearColumn])}`); return { ...r, [name]: null }; } return { ...r, [name]: outputNumber(decimal(r[step.valueColumn], step.valueColumn).minus(prior).div(prior.abs())) }; }); columns.push(name); break;
      }
      default: throw new Error('不支持的数据运算 / Unsupported data operation');
    }
  }
  return { columns, rows, warnings: [...new Set(warnings)] };
}
const xml = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function renderDataChart(data: DataSet, chart: { type: 'bar' | 'line'; x: string; y: string; title?: string }): string {
  exists(data.columns, chart.x); exists(data.columns, chart.y);
  if (!['bar', 'line'].includes(chart.type) || !data.rows.length || data.rows.length > 200) throw new Error('图表需要 1–200 个数据点 / Charts require 1–200 data points');
  const values = data.rows.map((r) => numeric(r[chart.y], chart.y));
  const min = Math.min(0, ...values), max = Math.max(0, ...values); const span = max - min || 1;
  const height = 340, left = 85, top = 65, width = 740, step = width / values.length;
  const y = (value: number) => top + height - ((value - min) / span) * height;
  const labels = values.map((v, i) => `<text x="${left + step * (i + .5)}" y="${top + height + 25}" text-anchor="middle" font-size="${values.length > 20 ? 8 : 11}">${xml(String(data.rows[i][chart.x]).slice(0, 16))}</text><title>${xml(data.rows[i][chart.x])}: ${v}</title>`).join('');
  const marks = chart.type === 'bar' ? values.map((v, i) => `<rect x="${left + step * (i + .12)}" y="${Math.min(y(v), y(0))}" width="${Math.max(1, step * .76)}" height="${Math.max(1, Math.abs(y(v) - y(0)))}" rx="2" fill="#6366f1"><title>${xml(data.rows[i][chart.x])}: ${v}</title></rect>`).join('') : `<polyline points="${values.map((v, i) => `${left + step * (i + .5)},${y(v)}`).join(' ')}" fill="none" stroke="#6366f1" stroke-width="3"/>` + values.map((v, i) => `<circle cx="${left + step * (i + .5)}" cy="${y(v)}" r="4" fill="#6366f1"><title>${xml(data.rows[i][chart.x])}: ${v}</title></circle>`).join('');
  const grid = Array.from({ length: 5 }, (_, i) => { const value = min + span * i / 4; return `<line x1="${left}" x2="${left + width}" y1="${y(value)}" y2="${y(value)}" stroke="#e2e8f0"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="12">${xml(Number(value.toPrecision(6)))}</text>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="500" viewBox="0 0 920 500"><rect width="920" height="500" fill="#fff"/><g fill="#334155" font-family="Arial,PingFang SC,Microsoft YaHei,sans-serif"><text x="${left}" y="32" font-size="19" font-weight="600">${xml(chart.title || `${chart.y} / ${chart.x}`)}</text>${grid}<line x1="${left}" x2="${left + width}" y1="${y(0)}" y2="${y(0)}" stroke="#94a3b8"/>${marks}${labels}<text x="${left}" y="477" font-size="11" fill="#64748b">MyAgent · Computed from ${data.rows.length} rows</text></g></svg>`;
}
