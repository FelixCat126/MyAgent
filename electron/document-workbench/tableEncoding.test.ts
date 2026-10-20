// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { decodeCsvBytes, readTable, MAX_WORKBOOK_FILE_SIZE } from './table';

const gbk = Buffer.from([0xb5, 0xd8, 0xc7, 0xf8, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xbb, 0xaa, 0xb6, 0xab, 0x2c, 0x31, 0x30]); // 地区,金额\n华东,10

describe('CSV decoding and workbook limits', () => {
  it('decodes GBK and UTF-16 CSV exports instead of producing mojibake', () => {
    expect(decodeCsvBytes(gbk)).toEqual({ text: '地区,金额\n华东,10', encoding: 'gb18030' });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('地区,金额', 'utf16le')]);
    expect(decodeCsvBytes(utf16).text).toBe('地区,金额');
    expect(decodeCsvBytes(Buffer.from('\uFEFF地区,金额', 'utf8')).encoding).toBe('utf-8');
  });
  it('reads a GBK CSV with correct headers and a warning', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'myagent-csv-'));
    try {
      const file = path.join(dir, 'sales.csv'); await fs.writeFile(file, gbk);
      const { table } = await readTable(file);
      expect(table.rows[0].map((c) => c.value)).toEqual(['地区', '金额']);
      expect(table.warnings.join(' ')).toContain('gb18030');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('rejects oversized workbooks before parsing and honours an aborted signal', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'myagent-xlsx-'));
    try {
      const big = path.join(dir, 'big.xlsx'); await fs.writeFile(big, Buffer.alloc(MAX_WORKBOOK_FILE_SIZE + 1));
      await expect(readTable(big)).rejects.toThrow('20MB');
      const csv = path.join(dir, 'a.csv'); await fs.writeFile(csv, 'a,b\n1,2');
      const controller = new AbortController(); controller.abort();
      await expect(readTable(csv, { signal: controller.signal })).rejects.toThrow('DOCUMENT_CANCELED');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
