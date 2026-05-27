import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
  buildAgentPathPolicy,
  isAgentPathAllowed,
  isAgentPathBlocked,
  isSystemCoreBlockedPath,
  resolveAgentPath,
  resolveAgentReadPath,
  resolveScopedAgentPath,
} from './agentPathScope';

describe('agentPathScope', () => {
  const home = path.resolve(os.homedir());

  it('resolveAgentPath 允许用户主目录内路径', () => {
    const r = resolveAgentPath('Documents/readme.md', []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(path.resolve(home, 'Documents/readme.md'));
    }
  });

  it('内置拦截系统核心目录', () => {
    const blocked =
      process.platform === 'win32'
        ? path.resolve('C:\\Windows\\System32\\drivers\\etc\\hosts')
        : process.platform === 'darwin'
          ? '/etc/hosts'
          : '/etc/passwd';
    expect(isSystemCoreBlockedPath(blocked)).toBe(true);
    const r = resolveAgentPath(blocked, []);
    expect(r.ok).toBe(false);
  });

  it('用户非授权路径会拦截其下文件', () => {
    const secret = path.join(home, 'Private', 'secret.md');
    const r = resolveAgentPath(secret, [path.join(home, 'Private')]);
    expect(r.ok).toBe(false);
    expect(isAgentPathBlocked(secret, [path.join(home, 'Private')])).toBe(true);
  });

  it('buildAgentPathPolicy 含主目录检索根', () => {
    const p = buildAgentPathPolicy([]);
    expect(p.searchRoots).toContain(home);
  });

  it('isAgentPathAllowed 与 isAgentPathBlocked 互斥（主目录内）', () => {
    const doc = path.join(home, 'Documents');
    expect(isAgentPathBlocked(doc, [])).toBe(false);
    expect(isAgentPathAllowed(doc, [])).toBe(true);
  });

  it('resolveAgentReadPath 在 Documents 下解析 list 相对路径', () => {
    const dir = path.join(home, 'Documents', '.myagent-agent-read-test');
    const file = path.join(dir, 'probe.txt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'probe');
    try {
      const r = resolveAgentReadPath('.myagent-agent-read-test/probe.txt', []);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.path).toBe(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveScopedAgentPath 仍可用于工作区 sandbox', () => {
    const root = path.resolve('/tmp/myagent-scope-root');
    const r = resolveScopedAgentPath('notes/readme.md', [root]);
    expect(r.ok).toBe(true);
  });
});
