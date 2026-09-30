import { AsyncLocalStorage } from 'node:async_hooks';

export const imageTaskContext = new AsyncLocalStorage<AbortSignal>();
export function checkImageTask(): void { imageTaskContext.getStore()?.throwIfAborted(); }

/** Link the task lifetime to an existing timeout controller, including response-body reads. */
export function bindImageTask(controller: AbortController): () => void {
  const signal = imageTaskContext.getStore();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}
