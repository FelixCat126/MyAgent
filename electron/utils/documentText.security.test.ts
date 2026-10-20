// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeTextBuffer, extractTextFromPath, isSensitiveReadPath } from './documentText';

describe('文本附件编码识别', () => {
  it('识别 UTF-8 BOM、UTF-16LE/BE（含无 BOM）与 GBK', () => {
    expect(decodeTextBuffer(Buffer.from('\uFEFF中文', 'utf8'))).toBe('中文');
    expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文abc', 'utf16le')]))).toBe('中文abc');
    const be = Buffer.from('ab', 'utf16le').swap16();
    expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('ab');
    expect(decodeTextBuffer(Buffer.from('name,value\nhello,1\n', 'utf16le'))).toBe('name,value\nhello,1\n');
    expect(decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
  });

  it('GBK 的 .csv 附件提取为正确中文', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-gbk-'));
    try {
      const p = path.join(dir, '数据 表 😀.csv');
      await fs.writeFile(p, Buffer.from([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0x31]));
      expect((await extractTextFromPath(p)).text).toBe('名称,1');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('读文件类 IPC 路径策略', () => {
  it('拒绝系统核心与凭据目录', () => {
    const home = os.homedir();
    expect(isSensitiveReadPath(path.join(home, '.ssh', 'id_rsa'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.aws', 'credentials'))).toBe(true);
    if (process.platform !== 'win32') expect(isSensitiveReadPath('/etc/passwd')).toBe(true);
  });

  it('不误伤用户文档与临时目录中的附件', () => {
    expect(isSensitiveReadPath(path.join(os.homedir(), 'Documents', '报告 2026.pdf'))).toBe(false);
    expect(isSensitiveReadPath(path.join(os.homedir(), 'Library', 'Application Support', 'MyAgent', 'myagent-uploads', 'a.png'))).toBe(false);
    expect(isSensitiveReadPath(path.join(os.tmpdir(), 'drag-in.txt'))).toBe(false);
  });
});
