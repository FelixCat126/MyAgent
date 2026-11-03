// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(), handle: vi.fn(), once: vi.fn(),
  addWriter: vi.fn(), info: vi.fn(), cleanup: vi.fn(), write: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { on: mocks.on, handle: mocks.handle },
  app: { getName: () => 'MyAgent', once: mocks.once },
}));
vi.mock('./logger', () => ({
  rootLogger: { addWriter: mocks.addWriter, info: mocks.info },
  rendererRootLogger: {},
}));
vi.mock('./logFile', () => ({
  writeLogLine: mocks.write,
  cleanupOldLogs: mocks.cleanup,
  LOG_CLEANUP_INTERVAL_MS: 6 * 60 * 60 * 1000,
}));

describe('logging maintenance', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('cleans old logs periodically and cancels maintenance at quit', async () => {
    const { bootstrapLogging } = await import('./loggerBootstrap');
    bootstrapLogging('test');
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    const quitHandler = mocks.once.mock.calls.find(([event]) => event === 'will-quit')![1];
    quitHandler();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate writers or maintenance if bootstrap is repeated', async () => {
    const { bootstrapLogging } = await import('./loggerBootstrap');
    bootstrapLogging('test');
    bootstrapLogging('test');
    expect(mocks.addWriter).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    expect(mocks.once).toHaveBeenCalledOnce();
  });
});
