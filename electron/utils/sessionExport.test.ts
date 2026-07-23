/** 会话导出 zip 工具 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { unzipSync, strFromU8 } from 'fflate';
import { buildSessionExportZip } from './sessionExport';
import type { ChatSession, Message } from '../../src/types';

const tmp = path.join(os.tmpdir(), `session-export-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function mkMsg(id: string, role: 'user' | 'assistant', content: string, extras: Partial<Message> = {}): Message {
  return {
    id,
    role,
    content,
    timestamp: 0,
    model: 'test',
    ...extras,
  };
}

describe('buildSessionExportZip', () => {
  beforeEach(async () => {
    await fs.mkdir(tmp, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('空会话也产出 session.json + messages.md', async () => {
    const session: ChatSession = {
      id: 's1',
      title: '空会话',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    };
    const out = path.join(tmp, 'empty.zip');
    const res = await buildSessionExportZip(session, out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.zipPath).toBe(out);
    const z = unzipSync(new Uint8Array(await fs.readFile(out)));
    expect(Object.keys(z).sort()).toEqual(['messages.md', 'session.json']);
    const json = JSON.parse(strFromU8(z['session.json']!));
    expect(json.session.id).toBe('s1');
    expect(json.messages).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('含附件 + 生图：附件入 attachments/，生图入 images/，同名不互盖', async () => {
    const attPath = path.join(tmp, 'att.txt');
    const imgPath = path.join(tmp, 'shot.png');
    await fs.writeFile(attPath, 'hello');
    await fs.writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const session: ChatSession = {
      id: 's2',
      title: '多附件',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        mkMsg('m1', 'user', 'hi', { files: [{ name: 'a.txt', path: attPath, type: 'text/plain', size: 5 }] }),
        mkMsg('m2', 'assistant', 'reply', { files: [{ name: 'a.txt', path: imgPath, type: 'image/png', size: 4 }] }),
      ],
    };
    const out = path.join(tmp, 'multi.zip');
    const res = await buildSessionExportZip(session, out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toEqual([]);
    const z = unzipSync(new Uint8Array(await fs.readFile(out)));
    const keys = Object.keys(z).sort();
    expect(keys).toContain('attachments/m1/1_a.txt');
    expect(keys).toContain('images/m2/1_a.png');
    expect(strFromU8(z['attachments/m1/1_a.txt']!)).toBe('hello');
    expect(z['images/m2/1_a.png']!.byteLength).toBe(4);
  });

  it('附件源文件丢失 → 记 warning + 标 missing，不抛错', async () => {
    const session: ChatSession = {
      id: 's3',
      title: '缺附件',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        mkMsg('m1', 'user', '?', { files: [{ name: 'gone.txt', path: '/nonexistent/gone.txt', type: 'text/plain', size: 0 }] }),
      ],
    };
    const out = path.join(tmp, 'missing.zip');
    const res = await buildSessionExportZip(session, out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toMatch(/gone\.txt/);
    expect(res.entries.find((e) => e.kind === 'attachment' && e.missing)).toBeTruthy();
  });

  it('messages.md 包含角色标记 + reasoning + 文件清单', async () => {
    const session: ChatSession = {
      id: 's4',
      title: 'md',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        mkMsg('u1', 'user', 'ask', { files: [{ name: 'a.txt', path: '/tmp/a', type: 'text/plain', size: 1 }] }),
        mkMsg('a1', 'assistant', 'reply', { reasoning: 'think', model: 'gpt-4' }),
      ],
    };
    const out = path.join(tmp, 'md.zip');
    const res = await buildSessionExportZip(session, out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const z = unzipSync(new Uint8Array(await fs.readFile(out)));
    const md = strFromU8(z['messages.md']!);
    expect(md).toMatch(/\[user\]/);
    expect(md).toMatch(/\[assistant\]/);
    expect(md).toMatch(/> think/);
    expect(md).toMatch(/a\.txt/);
  });
});
