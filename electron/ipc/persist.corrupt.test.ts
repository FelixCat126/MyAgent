// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ userData: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
  },
}));
await import('./persist');

const dir = () => path.join(state.userData, 'persist');
const get = (name: string) => state.handlers.get('persist-state-get')!({}, name) as Promise<string | null>;

beforeEach(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-persist-test-'));
  fs.mkdirSync(dir(), { recursive: true });
});
afterEach(() => fs.rmSync(state.userData, { recursive: true, force: true }));

describe('persist repository corruption', () => {
  it('quarantines an unreadable repository instead of letting defaults overwrite it', async () => {
    fs.writeFileSync(path.join(dir(), 'model-storage.json'), '{"state":{"models":[');
    expect(await get('model-storage')).toBeNull();
    expect(fs.existsSync(path.join(dir(), 'model-storage.json'))).toBe(false);
    const copies = fs.readdirSync(dir()).filter(name => /^model-storage\.corrupt-\d+\.json$/.test(name));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir(), copies[0]), 'utf8')).toBe('{"state":{"models":[');
  });

  it('reads valid repositories and split chat storage unchanged', async () => {
    fs.writeFileSync(path.join(dir(), 'setting-storage.json'), '{"state":{"locale":"en"},"version":18}');
    expect(JSON.parse((await get('setting-storage'))!)).toEqual({ state: { locale: 'en' }, version: 18 });
    fs.writeFileSync(path.join(dir(), 'chat-storage.json'), JSON.stringify({ state: { sessionIds: ['a'], sessionLayout: 'split-v1' }, version: 4 }));
    fs.writeFileSync(path.join(dir(), 'chat-session.a.json'), JSON.stringify({ id: 'a', messages: [] }));
    expect(JSON.parse((await get('chat-storage'))!).state.sessions).toEqual([{ id: 'a', messages: [] }]);
  });

  it('clear-all also removes vector indexes', async () => {
    const knowledge = path.join(state.userData, 'knowledge');
    fs.mkdirSync(knowledge, { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'vector-index-v1.json'), '{}');
    fs.writeFileSync(path.join(dir(), 'model-storage.json'), '{}');
    await state.handlers.get('persist-state-clear-all')!({});
    expect(fs.existsSync(knowledge)).toBe(false);
    expect(fs.readdirSync(dir())).toEqual([]);
  });
});
