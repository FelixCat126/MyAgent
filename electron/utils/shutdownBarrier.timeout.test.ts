// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdownBarrier } from './shutdownBarrier';

describe('Electron shutdown barrier timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('releases quit when cleanup never settles', async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const onError = vi.fn();
    const barrier = createShutdownBarrier({ cleanup: () => new Promise<void>(() => {}), quit, onError, timeoutMs: 50 });
    barrier({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(49);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }));
    const final = { preventDefault: vi.fn() };
    barrier(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });
});
