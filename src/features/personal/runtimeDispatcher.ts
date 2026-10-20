import { useChatStore } from '../../store/chatStore';
import type { RuntimeSnapshot, RuntimeTask } from '../runtime/api';
import { setConnectedExternalToolNames } from '../../agent/toolRegistry';

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

/** 任务只需等待它要写入的会话空闲；其他会话的前台回复可并行 */
function taskSessionBusy(task: RuntimeTask): boolean {
  const sessionId = typeof task.checkpoint?.sessionId === 'string' ? task.checkpoint.sessionId : null;
  if (!sessionId) return false;
  const chat = useChatStore.getState();
  return chat.isLoadingSession(sessionId) || chat.isCompressingSession(sessionId);
}

function nextRunnableTask(): RuntimeTask | undefined {
  for (const task of queue.values()) if (!taskSessionBusy(task)) return task;
  return undefined;
}

async function drain(): Promise<void> {
  if (draining || !executor || !nextRunnableTask()) return;
  draining = true;
  try {
    while (queue.size) {
      const run = getExecutor();
      if (!run) break;
      const task = nextRunnableTask();
      if (!task) break;
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
  const unsubscribe = useChatStore.subscribe(() => { if (queue.size) void drain(); });
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
  const syncExternalTools = (snapshot: RuntimeSnapshot) => setConnectedExternalToolNames(snapshot.connections.filter((c) => c.enabled && c.status === 'connected').map((c) => c.name));
  void window.electron.runtimeGetState().then((snapshot) => {
    if (!mounted) return;
    syncExternalTools(snapshot);
    snapshot.tasks.filter((task) => task.status === 'running' && !task.checkpoint?.foreground).forEach(dispatch);
  }).catch((error) => console.error('[Runtime dispatch state]', error));
  const unsubscribeState = window.electron.onRuntimeChanged?.((snapshot) => { if (mounted) syncExternalTools(snapshot); }) ?? (() => {});
  return () => { mounted = false; unsubscribe(); unsubscribeCancel(); unsubscribeState(); };
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
