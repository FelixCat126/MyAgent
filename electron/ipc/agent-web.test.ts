// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: vi.fn() } }));

const { isPrivateAddress } = await import('./agent-web');

describe('agent-web remote image SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1'])(
    'blocks private address %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true)
  );

  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '198.18.0.1', '2606:4700::1111'])('allows public address %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false)
  );
});
