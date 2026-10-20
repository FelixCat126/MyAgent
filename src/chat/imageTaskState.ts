// Cancellation belongs to a message, so starting a new turn cannot revive an old job.
const cancelled = new Set<string>();
export function cancelImageTask(id: string): void { cancelled.add(id); }
export function imageTaskWasCancelled(id: string): boolean { return cancelled.has(id); }
export function releaseImageTask(id: string): void { cancelled.delete(id); }

/** 运行令牌前缀：与消息 id 区分；重新生成/编辑重发复用同一用户消息 id，只有令牌能区分新旧两轮 */
const RUN_TOKEN_PREFIX = '\u0000reply-run:';
let runSeq = 0;
const replyRuns = new Map<string, { messageId: string; token: string; cancelled: boolean }>();
/** @returns 本轮唯一令牌；回复路径应以它（而非用户消息 id）判断是否已被停止或被新一轮顶替 */
export function beginReplyRun(sessionId: string, messageId: string): string {
  const token = `${RUN_TOKEN_PREFIX}${++runSeq}`;
  replyRuns.set(sessionId, { messageId, token, cancelled: false });
  return token;
}
export function cancelReplyRun(sessionId: string): void {
  const run = replyRuns.get(sessionId);
  if (run) run.cancelled = true;
}
/** 会话删除后丢弃记录；残留令牌随之视为已取消 */
export function forgetReplyRun(sessionId: string): void {
  replyRuns.delete(sessionId);
}
/** 接受本轮令牌或用户消息 id（旧调用方）；令牌不是当前轮即视为已取消 */
export function replyRunWasCancelled(sessionId: string, runOrMessageId: string): boolean {
  const run = replyRuns.get(sessionId);
  if (runOrMessageId.startsWith(RUN_TOKEN_PREFIX)) return !run || run.token !== runOrMessageId || run.cancelled;
  return !!run && (run.cancelled || run.messageId !== runOrMessageId);
}
