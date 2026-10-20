import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chatSessionFileName,
  readChatAssembledSync,
  removeChatStorageSync,
  writeChatFullTextSync,
  writeChatSplitSync,
} from './chatPersist';

let dir: string;
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf-8'));
const files = () => fs.readdirSync(dir).sort();
const session = (id: string, text = id) => ({ id, title: id, messages: [{ id: `${id}-m`, content: text }] });
const legacy = (sessions: unknown[]) => JSON.stringify({ state: { sessions, currentSessionId: 'a', activeLeafId: null }, version: 4 });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-chat-'));
  removeChatStorageSync(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('chat split persistence', () => {
  it('reads the legacy single-file layout unchanged', () => {
    const text = legacy([session('a'), session('b')]);
    fs.writeFileSync(path.join(dir, 'chat-storage.json'), text);
    expect(readChatAssembledSync(dir)).toBe(text);
  });

  it('migrates a legacy file into per-session files and keeps a pre-split copy', () => {
    const text = legacy([session('a'), session('b')]);
    fs.writeFileSync(path.join(dir, 'chat-storage.json'), text);
    writeChatFullTextSync(dir, text);
    expect(files()).toEqual(['chat-session.a.json', 'chat-session.b.json', 'chat-storage.json', 'chat-storage.pre-split.json']);
    expect(fs.readFileSync(path.join(dir, 'chat-storage.pre-split.json'), 'utf-8')).toBe(text);
    expect(read('chat-storage').state).toEqual({ currentSessionId: 'a', activeLeafId: null, sessionIds: ['a', 'b'], sessionLayout: 'split-v1' });
    expect(JSON.parse(readChatAssembledSync(dir)!)).toEqual(JSON.parse(text));
  });

  it('writes only changed sessions, keeps order, and removes deleted ones', () => {
    writeChatFullTextSync(dir, legacy([session('a'), session('b')]));
    const before = fs.statSync(path.join(dir, 'chat-session.a.json')).mtimeMs;
    writeChatSplitSync(dir, {
      index: JSON.stringify({ state: { currentSessionId: 'c', activeLeafId: null, sessionIds: ['c', 'a'] }, version: 4 }),
      ids: ['c', 'a'],
      sessions: { c: JSON.stringify(session('c', 'new')) },
    });
    expect(files()).toEqual(['chat-session.a.json', 'chat-session.c.json', 'chat-storage.json']);
    expect(fs.statSync(path.join(dir, 'chat-session.a.json')).mtimeMs).toBe(before);
    const assembled = JSON.parse(readChatAssembledSync(dir)!);
    expect(assembled.state.sessions.map((s: { id: string }) => s.id)).toEqual(['c', 'a']);
    expect(assembled.state.currentSessionId).toBe('c');
    expect(assembled.state.sessionIds).toBeUndefined();
  });

  it('isolates a corrupt session file without losing the others', () => {
    writeChatFullTextSync(dir, legacy([session('a'), session('b')]));
    fs.writeFileSync(path.join(dir, 'chat-session.a.json'), '{broken');
    const assembled = JSON.parse(readChatAssembledSync(dir)!);
    expect(assembled.state.sessions.map((s: { id: string }) => s.id)).toEqual(['b']);
    expect(files().some((f) => f.startsWith('chat-corrupt.') && f.endsWith('.a.json'))).toBe(true);
  });

  it('merges sessions embedded by a restored legacy backup with split files', () => {
    writeChatFullTextSync(dir, legacy([session('a', 'split')]));
    const index = read('chat-storage');
    index.state.sessions = [session('a', 'legacy'), session('old')];
    fs.writeFileSync(path.join(dir, 'chat-storage.json'), JSON.stringify(index));
    const sessions = JSON.parse(readChatAssembledSync(dir)!).state.sessions;
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'old']);
    expect(sessions[0].messages[0].content).toBe('split');
  });

  it('maps unsafe ids to stable hashed file names', () => {
    const name = chatSessionFileName('../会话 1');
    expect(name).toMatch(/^chat-session\.h[0-9a-f]{40}$/);
    expect(chatSessionFileName('../会话 1')).toBe(name);
    writeChatFullTextSync(dir, legacy([session('../会话 1')]));
    expect(JSON.parse(readChatAssembledSync(dir)!).state.sessions[0].id).toBe('../会话 1');
  });

  /** 用空目录调用 removeChatStorageSync 清空进程内缓存，模拟重启 */
  const simulateRestart = () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-chat-empty-'));
    removeChatStorageSync(empty);
    fs.rmSync(empty, { recursive: true, force: true });
  };

  it('rebuilds from session files when the index is corrupt', () => {
    writeChatFullTextSync(dir, legacy([session('a'), session('b')]));
    fs.writeFileSync(path.join(dir, 'chat-storage.json'), '{"state":{"sessionIds":["a","b"');
    simulateRestart();
    const assembled = JSON.parse(readChatAssembledSync(dir)!);
    expect(assembled.state.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    expect(files().some((f) => f.startsWith('chat-corrupt.') && f.includes('index'))).toBe(true);
  });

  it('never deletes session files the renderer did not load', () => {
    writeChatFullTextSync(dir, legacy([session('a'), session('b')]));
    simulateRestart();
    writeChatSplitSync(dir, {
      index: JSON.stringify({ state: { sessionIds: ['c'] }, version: 4 }),
      ids: ['c'],
      sessions: { c: JSON.stringify(session('c')) },
    });
    expect(files()).toEqual(['chat-session.a.json', 'chat-session.b.json', 'chat-session.c.json', 'chat-storage.json']);
  });

  it('removes the index and every session file', () => {
    writeChatFullTextSync(dir, legacy([session('a'), session('b')]));
    removeChatStorageSync(dir);
    expect(files()).toEqual([]);
    expect(readChatAssembledSync(dir)).toBeNull();
  });
});
