// @vitest-environment node
import os from 'os';
import path from 'path';
import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isAgentPathAllowed,
  isSensitiveAgentPath,
  realAgentPath,
  registerAgentProtectedPaths,
  resolveAgentPath,
  resolveAgentReadPath,
} from './agentPathScope';

const home = path.resolve(os.homedir());
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

describe('agentPathScope 安全回归', () => {
  let root: string;
  let secretDir: string;
  let link: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(home, '.myagent-scope-sec-'));
    secretDir = path.join(root, 'secret');
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, 'a.txt'), 'top secret');
    link = path.join(root, 'link');
    fs.symlinkSync(secretDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  });

  afterAll(() => {
    registerAgentProtectedPaths([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'darwin')('拦截 macOS /private/etc、/private/var 真实路径', () => {
    expect(resolveAgentReadPath('/private/etc/passwd', []).ok).toBe(false);
    expect(resolveAgentPath('/private/var/db', []).ok).toBe(false);
    const realTmp = fs.realpathSync.native(os.tmpdir());
    expect(resolveAgentPath(path.join(realTmp, 'myagent-probe.txt'), []).ok).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('符号链接指向系统目录时按真实路径拦截', () => {
    const etcLink = path.join(root, 'etc-link');
    fs.symlinkSync('/etc', etcLink);
    expect(resolveAgentReadPath(path.join(etcLink, 'hosts'), []).ok).toBe(false);
    expect(resolveAgentPath(path.join(etcLink, 'not-yet-created.txt'), []).ok).toBe(false);
  });

  it('符号链接不能绕过用户非授权路径', () => {
    expect(resolveAgentReadPath(path.join(link, 'a.txt'), [secretDir]).ok).toBe(false);
    expect(resolveAgentPath(path.join(link, 'a.txt'), [secretDir]).ok).toBe(false);
    expect(realAgentPath(path.join(link, 'missing', 'b.txt'))).toBe(
      path.join(fs.realpathSync.native(secretDir), 'missing', 'b.txt')
    );
  });

  it.runIf(caseInsensitive)('大小写变化不能绕过非授权路径（macOS / Windows）', () => {
    const upper = path.join(root.toUpperCase(), 'SECRET', 'A.TXT');
    expect(resolveAgentReadPath(upper, [secretDir]).ok).toBe(false);
    expect(isAgentPathAllowed(upper, [secretDir])).toBe(false);
  });

  it('默认拦截主目录下的密钥与凭证目录', () => {
    for (const p of ['~/.ssh/id_rsa', '~/.aws/credentials', '~/.gnupg/secring.gpg', '~/.kube/config']) {
      const r = resolveAgentReadPath(p, []);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.error).toContain('密钥');
    }
    expect(resolveAgentReadPath('.ssh/id_rsa', []).ok).toBe(false);
    expect(isSensitiveAgentPath(path.join(home, 'Documents', 'notes.md'))).toBe(false);
  });

  it('应用登记的私有数据路径不可读，同级其它目录不受影响', () => {
    const userData = path.join(root, 'userData');
    registerAgentProtectedPaths([path.join(userData, 'persist'), path.join(userData, 'remote-gateway.json')]);
    expect(resolveAgentReadPath(path.join(userData, 'persist', 'model-storage.json'), []).ok).toBe(false);
    expect(resolveAgentReadPath(path.join(userData, 'remote-gateway.json'), []).ok).toBe(false);
    expect(isAgentPathAllowed(path.join(userData, 'myagent-uploads', 'a.png'), [])).toBe(true);
  });

  it('普通主目录文件仍可访问', () => {
    expect(resolveAgentReadPath(path.join(secretDir, 'a.txt'), []).ok).toBe(true);
    expect(resolveAgentPath('Documents/readme.md', []).ok).toBe(true);
  });
});
