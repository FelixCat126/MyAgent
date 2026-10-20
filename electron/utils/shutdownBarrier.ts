interface QuitEvent { preventDefault(): void }

export const SHUTDOWN_CLEANUP_TIMEOUT_MS = 10_000;

/** Electron does not await event handlers; keep the first quit alive until cleanup settles or times out. */
export function createShutdownBarrier(options: {
  cleanup: () => Promise<void>;
  quit: () => void;
  onError: (error: unknown) => void;
  timeoutMs?: number;
}): (event: QuitEvent) => void {
  let draining = false;
  let ready = false;
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_CLEANUP_TIMEOUT_MS;
  return event => {
    if (ready) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Shutdown cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    void Promise.race([Promise.resolve().then(options.cleanup), deadline]).catch(error => {
      try { options.onError(error); } catch { /* Reporting must not keep the app alive. */ }
    }).finally(() => {
      if (timer) clearTimeout(timer);
      ready = true;
      options.quit();
    });
  };
}
