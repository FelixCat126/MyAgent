// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(async ({ buffer }: { buffer: Buffer }) => ({
      value: `MAMMOTH:${buffer.length}`,
      messages: [],
    })),
  },
}));

import { extractTextFromPath } from './documentText';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'myagent-doctxt-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('extractTextFromPath（多格式提取）', () => {
  beforeEach(() => {
    vi.mocked(mammoth.extractRawText).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('.md / .txt：直接读 UTF-8，kind 为对应扩展名', async () => {
    await withTmpDir(async (dir) => {
      const mdPath = path.join(dir, 'a.md');
      const txtPath = path.join(dir, 'b.txt');
      fs.writeFileSync(mdPath, '# 标题\n正文', 'utf8');
      fs.writeFileSync(txtPath, '纯文本', 'utf8');
      const m = await extractTextFromPath(mdPath);
      const t = await extractTextFromPath(txtPath);
      expect(m).toEqual({ text: '# 标题\n正文', kind: 'md' });
      expect(t).toEqual({ text: '纯文本', kind: 'txt' });
    });
  });

  it('.doc 二进制：返回引导用户另存的提示，不调用 mammoth', async () => {
    const r = await extractTextFromPath('/no/such/legacy.doc');
    expect(r.kind).toBe('doc-legacy');
    expect(r.text).toMatch(/二进制 \.doc/);
    expect(vi.mocked(mammoth.extractRawText)).not.toHaveBeenCalled();
  });

  it('.docx：调用 mammoth 提取并截断至上限', async () => {
    await withTmpDir(async (dir) => {
      const p = path.join(dir, 'x.docx');
      fs.writeFileSync(p, Buffer.from([1, 2, 3, 4, 5]));
      const r = await extractTextFromPath(p);
      expect(r.kind).toBe('docx');
      expect(r.text).toMatch(/^MAMMOTH:5$/);
      expect(vi.mocked(mammoth.extractRawText)).toHaveBeenCalledOnce();
    });
  });

  it('.docx 空文本时给提示文案', async () => {
    vi.mocked(mammoth.extractRawText).mockResolvedValueOnce({
      value: '',
      messages: [],
    });
    await withTmpDir(async (dir) => {
      const p = path.join(dir, 'empty.docx');
      fs.writeFileSync(p, Buffer.from([0]));
      const r = await extractTextFromPath(p);
      expect(r.text).toMatch(/无文本内容/);
    });
  });

  it('.xls 旧版：提示另存为 xlsx', async () => {
    const r = await extractTextFromPath('/no/such/file.xls');
    expect(r.kind).toBe('xls-legacy');
    expect(r.text).toMatch(/请另存为 \.xlsx/);
  });

  it('.xlsx：将工作表渲染为 Markdown 管道表格', async () => {
    await withTmpDir(async (dir) => {
      const p = path.join(dir, 'data.xlsx');
      const wb = new ExcelJS.Workbook();
      const sh = wb.addWorksheet('Sheet1');
      sh.addRow(['名称', '数量']);
      sh.addRow(['苹果', 3]);
      sh.addRow(['梨', 5]);
      await wb.xlsx.writeFile(p);

      const r = await extractTextFromPath(p, 'data.xlsx');
      expect(r.kind).toBe('xlsx');
      expect(r.text).toMatch(/【Excel: data\.xlsx】/);
      expect(r.text).toContain('### 工作表: Sheet1');
      expect(r.text).toContain('| 名称 | 数量 |');
      expect(r.text).toContain('| --- | --- |');
      expect(r.text).toContain('| 苹果 | 3 |');
      expect(r.text).toContain('| 梨 | 5 |');
    });
  });

  it('未知扩展名：返回不支持提示', async () => {
    const r = await extractTextFromPath('/tmp/some.zip');
    expect(r.kind).toBe('unsupported');
    expect(r.text).toMatch(/不支持的格式/);
  });
});
