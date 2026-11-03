// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createProcessErrorHandlers } from './processErrorHandlers';

describe('process error reporting', () => {
  it('records exceptions and rejections through the supplied file sink only', () => {
    const sink = vi.fn();
    const handlers = createProcessErrorHandlers(sink, () => 0);
    handlers.onUncaughtException(new Error('write EIO'));
    handlers.onUnhandledRejection('rejected');
    const [fatal, rejection] = sink.mock.calls.map(([line]) => JSON.parse(line));
    expect(fatal).toMatchObject({ level: 'fatal', msg: 'main uncaughtException' });
    expect(fatal.error).toContain('write EIO');
    expect(rejection).toMatchObject({ level: 'error', error: 'rejected' });
  });

  it('contains sink failures without reporting them recursively', () => {
    const sink = vi.fn(() => { throw new Error('file unavailable'); });
    const handlers = createProcessErrorHandlers(sink);
    expect(() => handlers.onUncaughtException(new Error('original'))).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
  });

  it('limits exceptions across event-loop ticks and resumes with a suppressed count', async () => {
    let time = 0;
    const sink = vi.fn();
    const handlers = createProcessErrorHandlers(sink, () => time);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      handlers.onUncaughtException(new Error('repeated'));
    }
    expect(sink).toHaveBeenCalledTimes(10);
    time = 60_000;
    handlers.onUnhandledRejection('next window');
    expect(sink).toHaveBeenCalledTimes(11);
    expect(JSON.parse(sink.mock.calls[10][0])).toMatchObject({ suppressed: 20 });
    handlers.onUnhandledRejection('another');
    expect(JSON.parse(sink.mock.calls[11][0])).not.toHaveProperty('suppressed');
  });

  it('contains recursive sink callbacks', () => {
    const sink = vi.fn((): void => handlers.onUncaughtException(new Error('recursive')));
    const handlers = createProcessErrorHandlers(sink, () => 0);
    handlers.onUncaughtException(new Error('initial'));
    expect(sink).toHaveBeenCalledTimes(10);
  });

  it('bounds error details and handles unprintable rejection values', () => {
    const sink = vi.fn();
    const handlers = createProcessErrorHandlers(sink, () => 0);
    handlers.onUnhandledRejection('x'.repeat(100_000));
    handlers.onUnhandledRejection({ toString() { throw new Error('cannot stringify'); } });
    expect(JSON.parse(sink.mock.calls[0][0]).error).toHaveLength(16 * 1024);
    expect(JSON.parse(sink.mock.calls[1][0]).error).toBe('[unprintable error]');
  });
});
