// Cancellation belongs to a message, so starting a new turn cannot revive an old job.
const cancelled = new Set<string>();
export function cancelImageTask(id: string): void { cancelled.add(id); }
export function imageTaskWasCancelled(id: string): boolean { return cancelled.has(id); }
export function releaseImageTask(id: string): void { cancelled.delete(id); }

const replyRuns = new Map<string, { messageId: string; cancelled: boolean }>();
export function beginReplyRun(sessionId: string, messageId: string): void {
  replyRuns.set(sessionId, { messageId, cancelled: false });
}
export function cancelReplyRun(sessionId: string): void {
  const run = replyRuns.get(sessionId);
  if (run) run.cancelled = true;
}
export function replyRunWasCancelled(sessionId: string, messageId: string): boolean {
  const run = replyRuns.get(sessionId);
  return !!run && (run.cancelled || run.messageId !== messageId);
}
