// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), openPath: vi.fn(async () => ''), userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  shell: { openPath: state.openPath },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) },
}));
import { uploadStorageName, writeUploadBufferToUserData } from './file';

describe('附件落盘命名', () => {
  it('同一毫秒内同长度中文名不再撞名，且保留可读名与扩展名', () => {
    const a = uploadStorageName('报告.pdf', 1);
    const b = uploadStorageName('合同.pdf', 1);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^1-[0-9a-f]{8}-报告\.pdf$/);
    expect(uploadStorageName('../../a b😀.txt', 1)).toMatch(/^1-[0-9a-f]{8}-a b😀\.txt$/);
    expect(Buffer.byteLength(uploadStorageName('x'.repeat(400) + '.md', 1))).toBeLessThan(255);
  });

  it('重名附件写入后互不覆盖', async () => {
    state.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-upload-'));
    try {
      const [a, b] = await Promise.all([
        writeUploadBufferToUserData({ name: '报告.txt', buffer: Buffer.from('A'), type: 'text/plain', size: 1 }),
        writeUploadBufferToUserData({ name: '报告.txt', buffer: Buffer.from('B'), type: 'text/plain', size: 1 }),
      ]);
      expect(a.path).not.toBe(b.path);
      expect(await fs.readFile(a.path, 'utf8')).toBe('A');
      expect(await fs.readFile(b.path, 'utf8')).toBe('B');
    } finally {
      await fs.rm(state.userData, { recursive: true, force: true });
    }
  });
});

describe('open-local-file', () => {
  it('拒绝可执行文件与脚本，普通文档照常打开', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-open-'));
    try {
      const handler = state.handlers.get('open-local-file')!;
      for (const name of ['run.command', 'x.sh', 'setup.exe', 'a.bat', 'p.ps1', 'i.msi', 's.scpt', 'j.jar', 'l.lnk', 'w.workflow']) {
        const p = path.join(dir, name);
        await fs.writeFile(p, 'echo');
        expect(await handler({}, { path: p })).toMatchObject({ ok: false });
      }
      const doc = path.join(dir, '报告 😀.docx');
      await fs.writeFile(doc, 'x');
      expect(await handler({}, { path: doc })).toEqual({ ok: true });
      expect(state.openPath).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
