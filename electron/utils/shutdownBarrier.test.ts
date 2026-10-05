// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createShutdownBarrier } from './shutdownBarrier';

describe('Electron shutdown barrier', () => {
  it('waits for cleanup, prevents reentry, and permits the final quit', async () => {
    let resolve!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const quit = vi.fn();
    const onError = vi.fn();
    const barrier = createShutdownBarrier({ cleanup, quit, onError });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    barrier(first);
    barrier(second);
    await Promise.resolve();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    const final = { preventDefault: vi.fn() };
    barrier(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('releases quit even when cleanup and error reporting fail', async () => {
    const error = new Error('close failed');
    const quit = vi.fn();
    const onError = vi.fn(() => { throw new Error('log failed'); });
    const barrier = createShutdownBarrier({ cleanup: async () => { throw error; }, quit, onError });
    barrier({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(error);
    const final = { preventDefault: vi.fn() };
    barrier(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });
});
