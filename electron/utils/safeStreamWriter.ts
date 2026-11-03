/** A failed output channel must never feed another error back into the logger. */
export function createSafeStreamWriter(stream: NodeJS.WritableStream): (line: string) => void {
  const output = stream as NodeJS.WritableStream & {
    destroyed?: boolean;
    writableEnded?: boolean;
    writableFinished?: boolean;
    errored?: unknown;
    closed?: boolean;
  };
  let failed = false;
  let blocked = false;
  let writing = false;
  let drains = 0;

  const disable = (): void => {
    failed = true;
    blocked = false;
  };

  // Keep this listener after failure: a late or repeated error must also be consumed.
  stream.on('error', disable);
  stream.on('drain', () => {
    drains++;
    blocked = false;
  });

  return (line: string): void => {
    if (failed || blocked || writing) return;
    if (output.destroyed || output.writableEnded || output.writableFinished ||
        output.closed || output.errored || output.writable === false) {
      disable();
      return;
    }
    writing = true;
    const previousDrains = drains;
    try {
      const accepted = stream.write(line, (error?: Error | null) => {
        if (error) disable();
      });
      // A synchronous drain/error may fire inside write(). Never overwrite either state.
      if (!failed) blocked = !accepted && drains === previousDrains;
    } catch {
      disable();
    } finally {
      writing = false;
    }
  };
}
