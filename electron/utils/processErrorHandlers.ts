/** Global exceptions use the bounded file sink directly, never stdout/stderr. */
export function createProcessErrorHandlers(
  writeLine: (line: string) => void,
  now: () => number = Date.now,
): {
  onUncaughtException: (error: unknown) => void;
  onUnhandledRejection: (reason: unknown) => void;
} {
  const windowMs = 60_000;
  const maxPerWindow = 10;
  let windowStarted: number | undefined;
  let written = 0;
  let dropped = 0;

  function record(level: 'fatal' | 'error', msg: string, error: unknown): void {
    try {
      const time = now();
      if (windowStarted === undefined || time - windowStarted >= windowMs) {
        windowStarted = time;
        written = 0;
      }
      if (written >= maxPerWindow) {
        dropped++;
        return;
      }
      // Count before calling the sink, including failed writes and synchronous reentry.
      written++;
      let detail: string;
      try {
        detail = error instanceof Error ? error.stack || error.message : String(error);
      } catch {
        detail = '[unprintable error]';
      }
      const line = JSON.stringify({
        t: new Date(time).toISOString(),
        level,
        name: 'app',
        msg,
        error: detail.slice(0, 16 * 1024),
        ...(dropped ? { suppressed: dropped } : {}),
      }) + '\n';
      dropped = 0;
      writeLine(line);
    } catch {
      // Reporting failures must never be reported through another logger.
    }
  }

  return {
    onUncaughtException: error => record('fatal', 'main uncaughtException', error),
    onUnhandledRejection: reason => record('error', 'main unhandledRejection', reason),
  };
}
