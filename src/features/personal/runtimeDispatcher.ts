import { useChatStore } from '../../store/chatStore';
import type { RuntimeTask } from '../runtime/api';

export type RuntimeTaskExecutor = (task: RuntimeTask) => Promise<void>;
let executor: RuntimeTaskExecutor | null = null;
let cancelExecutor: ((taskId: string) => void) | null = null;
let draining = false;
let activeTaskId: string | null = null;
const queue = new Map<string, RuntimeTask>();
const handledRevisions = new Map<string, number>();
const cancelledTasks = new Set<string>();
function getExecutor(): RuntimeTaskExecutor | null { return executor; }
export function runtimeTaskWasCancelled(taskId: string): boolean { return cancelledTasks.has(taskId); }

function isBusy(): boolean {
  const chat = useChatStore.getState();
  return chat.loadingSessionIds.size > 0 || chat.compressingSessionIds.size > 0;
}

async function drain(): Promise<void> {
  if (draining || !executor || isBusy()) return;
  draining = true;
  try {
    while (queue.size && !isBusy()) {
      const run = getExecutor();
      if (!run) break;
      const task = queue.values().next().value as RuntimeTask;
      queue.delete(task.id);
      activeTaskId = task.id;
      handledRevisions.set(task.id, task.updatedAt);
      try { await run(task); }
      catch (error) {
        try { await window.electron.runtimeCompleteTask({ id: task.id, error: error instanceof Error ? error.message : String(error) }); }
        catch (completionError) { console.error('[Runtime dispatcher]', completionError); }
      }
      finally { activeTaskId = null; }
    }
  } finally { draining = false; }
}

export function enqueueRuntimeTask(task: RuntimeTask): void {
  if (task.kind !== 'agent' || task.status !== 'running') return;
  if (activeTaskId === task.id || queue.has(task.id) || (handledRevisions.get(task.id) ?? -1) >= task.updatedAt) return;
  cancelledTasks.delete(task.id);
  queue.set(task.id, task);
  void drain();
}

export function registerRuntimeTaskExecutor(run: RuntimeTaskExecutor, cancel: (taskId: string) => void): () => void {
  executor = run;
  cancelExecutor = cancel;
  const unsubscribe = useChatStore.subscribe(() => { if (!isBusy()) void drain(); });
  void drain();
  return () => { unsubscribe(); if (executor === run) { executor = null; cancelExecutor = null; } };
}

export function installRuntimeDispatchBridge(onTaskQueued: (task: RuntimeTask) => void): () => void {
  if (!window.electron?.onRuntimeTaskDispatch) return () => {};
  const dispatch = (task: RuntimeTask) => { onTaskQueued(task); enqueueRuntimeTask(task); };
  const unsubscribe = window.electron.onRuntimeTaskDispatch(dispatch);
  const unsubscribeCancel = window.electron.onRuntimeTaskCancel((id) => {
    cancelledTasks.add(id);
    queue.delete(id);
    if (activeTaskId === id) cancelExecutor?.(id);
  });
  // Recover a dispatched event that raced renderer mounting, without rerunning foreground turns.
  let mounted = true;
  void window.electron.runtimeGetState().then((snapshot) => {
    if (mounted) snapshot.tasks.filter((task) => task.status === 'running' && !task.checkpoint?.foreground).forEach(dispatch);
  }).catch((error) => console.error('[Runtime dispatch state]', error));
  return () => { mounted = false; unsubscribe(); unsubscribeCancel(); };
}

/** A streaming start promise can resolve early; wait for the real session terminal boundary. */
export function waitForSessionTaskEnd(sessionId: string): Promise<void> {
  const done = () => !useChatStore.getState().isLoadingSession(sessionId) && !useChatStore.getState().isCompressingSession(sessionId);
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe(() => { if (done()) { unsubscribe(); resolve(); } });
    if (done()) { unsubscribe(); resolve(); }
  });
}
