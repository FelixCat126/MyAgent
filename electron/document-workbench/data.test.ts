// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dataFromTable, executeDataPlan, renderDataChart } from './data';
import { parseCsv, parseRange } from './table';
const input = { columns: ['team', 'year', 'value'], rows: [{ team: 'A', year: 2024, value: 10 }, { team: 'A', year: 2025, value: 15 }, { team: 'B', year: 2024, value: 0 }, { team: 'B', year: 2025, value: 12 }], warnings: [] };
describe('safe declarative data engine', () => {
  it('filters, deduplicates and sums actual numeric rows', () => {
    const duplicated = { ...input, rows: [...input.rows, input.rows[0]] };
    const result = executeDataPlan(duplicated, [{ op: 'dedupe' }, { op: 'filter', column: 'value', operator: 'gte', value: 10 }, { op: 'group', by: ['team'], aggregates: [{ column: 'value', function: 'sum', as: 'total' }] }]);
    expect(result.rows).toEqual([{ team: 'A', total: 25 }, { team: 'B', total: 12 }]);
  });
  it('computes YoY and reports missing/zero baselines instead of dividing by zero', () => {
    const result = executeDataPlan(input, [{ op: 'yoy', yearColumn: 'year', valueColumn: 'value', by: ['team'] }]);
    expect(result.rows[1].YoY).toBe(.5); expect(result.rows[0].YoY).toBeNull(); expect(result.rows[3].YoY).toBeNull(); expect(result.warnings).toHaveLength(2);
  });
  it('rejects malformed steps, nonexistent columns, duplicate year groups and nonnumeric aggregation', () => {
    expect(() => executeDataPlan(input, [{ op: 'filter', column: 'bad', operator: 'eq', value: '' }])).toThrow(/Column not found/);
    expect(() => executeDataPlan(input, [{ op: 'group', by: [], aggregates: [{ column: 'team', function: 'sum', as: 'sum' }] }])).toThrow(/Non-numeric/);
    expect(() => executeDataPlan({ ...input, rows: [...input.rows, input.rows[0]] }, [{ op: 'yoy', yearColumn: 'year', valueColumn: 'value', by: ['team'] }])).toThrow(/Group by year/);
    expect(() => executeDataPlan(input, [{ op: 'execute', code: 'process.exit()' } as never])).toThrow(/Unsupported/);
  });
  it('creates escaped SVG with measured data, including negative values', () => {
    const result = { columns: ['label', 'number'], rows: [{ label: '<script>', number: -3 }, { label: 'B', number: 5 }], warnings: [] };
    const svg = renderDataChart(result, { type: 'bar', x: 'label', y: 'number', title: '<svg onload="x">' });
    expect(svg).toContain('&lt;script&gt;'); expect(svg).not.toContain('<script>'); expect(svg).toContain('Computed from 2 rows'); expect(svg).toContain(': -3');
  });
  it('parses quoted CSV newlines and rejects incomplete quotes and excessive ranges', () => {
    expect(parseCsv('\uFEFFA,B\r\n"hello,world","line\nnext"\r\n"a""b",3')).toEqual([['A', 'B'], ['hello,world', 'line\nnext'], ['a"b', '3']]);
    expect(() => parseCsv('A,"unfinished')).toThrow(/Unclosed/); expect(() => parseRange('A1:C10002', 10002, 3)).toThrow(/10,000/);
  });
  it('rejects duplicate headers and supports cancellation', () => {
    expect(() => dataFromTable({ columns: ['A', 'B'], rows: [[{ address: 'A1', value: 'name' }, { address: 'B1', value: 'name' }]], sheet: 'S', range: 'A1:B1', totalRows: 1, truncated: false, warnings: [] })).toThrow(/Duplicate/);
    const controller = new AbortController(); controller.abort(); expect(() => executeDataPlan(input, [{ op: 'dedupe' }], controller.signal)).toThrow('DOCUMENT_CANCELED');
  });
  it('treats prototype-like column names as data and refuses overflowed totals', () => {
    const result = executeDataPlan(input, [{ op: 'group', by: [], aggregates: [{ column: 'value', function: 'sum', as: '__proto__' }] }]);
    expect(Object.prototype.hasOwnProperty.call(result.rows[0], '__proto__')).toBe(true); expect(result.rows[0].__proto__).toBe(37);
    expect(() => executeDataPlan({ columns: ['v'], rows: [{ v: 1e308 }, { v: 1e308 }], warnings: [] }, [{ op: 'group', by: [], aggregates: [{ column: 'v', function: 'sum', as: 'sum' }] }])).toThrow(/numeric range/);
  });
  it('sums and averages monetary decimals and calculates YoY without binary floating-point artifacts', () => {
    const money = { columns: ['amount'], rows: [{ amount: .1 }, { amount: '0.2' }], warnings: [] };
    const grouped = executeDataPlan(money, [{ op: 'group', by: [], aggregates: [{ column: 'amount', function: 'sum', as: 'sum' }, { column: 'amount', function: 'avg', as: 'avg' }] }]);
    expect(grouped.rows[0]).toEqual({ sum: .3, avg: .15 });
    const cents = executeDataPlan({ columns: ['v'], rows: Array.from({ length: 1000 }, () => ({ v: '0.01' })), warnings: [] }, [{ op: 'group', by: [], aggregates: [{ column: 'v', function: 'sum', as: 'total' }] }]); expect(cents.rows[0].total).toBe(10);
    const yoy = executeDataPlan({ columns: ['year', 'value'], rows: [{ year: 2024, value: '0.1' }, { year: 2025, value: '0.3' }], warnings: [] }, [{ op: 'yoy', yearColumn: 'year', valueColumn: 'value' }]); expect(yoy.rows[1].YoY).toBe(2);
  });
  it('rejects unsafe integer numbers and strings before precision can silently disappear', () => {
    for (const value of ['9007199254740993', '9,007,199,254,740,993', '-9007199254740993', Number.MAX_SAFE_INTEGER + 1]) expect(() => executeDataPlan({ columns: ['v'], rows: [{ v: value }], warnings: [] }, [{ op: 'group', by: [], aggregates: [{ column: 'v', function: 'sum', as: 'sum' }] }])).toThrow(/Unsafe integer/);
    expect(() => executeDataPlan({ columns: ['v'], rows: [{ v: Number.MAX_SAFE_INTEGER }, { v: 1 }], warnings: [] }, [{ op: 'group', by: [], aggregates: [{ column: 'v', function: 'sum', as: 'sum' }] }])).toThrow(/numeric range/);
  });
});
