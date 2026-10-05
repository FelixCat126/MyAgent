interface QuitEvent { preventDefault(): void }

/** Electron does not await event handlers; keep the first quit alive until cleanup settles. */
export function createShutdownBarrier(options: {
  cleanup: () => Promise<void>;
  quit: () => void;
  onError: (error: unknown) => void;
}): (event: QuitEvent) => void {
  let draining = false;
  let ready = false;
  return event => {
    if (ready) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    void Promise.resolve().then(options.cleanup).catch(error => {
      try { options.onError(error); } catch { /* Reporting must not keep the app alive. */ }
    }).finally(() => {
      ready = true;
      options.quit();
    });
  };
}
