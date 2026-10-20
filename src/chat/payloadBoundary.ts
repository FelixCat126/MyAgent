import type { Message, ModelConfig } from '../types';
import { CONTEXT_COMPRESS_RATIO } from '../utils/contextBudget';

/** 单条消息送入模型前的硬截断（与 sanitizeMessagesForModel 同源） */
export const SANITIZE_MAX_CONTENT_CHARS = 80_000;

/** 与 enrichMessagesForModel / documents IPC 正文字数上限一致 */
export const ATTACH_DOCUMENT_MAX_TEXT_CHARS = 600_000;

/**
 * 预算层可感知的「截断风险」：若任一消息 content 超过硬上限，
 * 进度条/发送前可提示用户部分内容会被截断。
 */
export function messagesExceedSanitizeLimit(
  messages: Array<{ content?: string }>,
  maxChars = SANITIZE_MAX_CONTENT_CHARS
): boolean {
  return messages.some((m) => String(m.content ?? '').length > maxChars);
}

/**
 * 估算 enrich 后可能额外注入的字符（RAG/工作区/联网），
 * 用于发送前二次护栏：存储消息看似安全，但真实 payload 可能超预算。
 */
export function estimateInjectedPayloadOverheadChars(opts: {
  webEnabled?: boolean;
  ragLikely?: boolean;
  workspaceLikely?: boolean;
  ragMaxChars?: number;
  workspaceMaxChars?: number;
}): number {
  let n = 0;
  if (opts.webEnabled) n += 12_000;
  if (opts.ragLikely) n += Math.min(opts.ragMaxChars ?? 24_000, 80_000);
  if (opts.workspaceLikely) n += Math.min(opts.workspaceMaxChars ?? 40_000, 200_000);
  return n;
}

/** 发送前：存储 prior + draft + 注入开销 是否逼近产品软上限 */
export function shouldWarnPayloadNearLimit(opts: {
  storedChars: number;
  injectedOverhead: number;
  softLimitChars: number;
  ratio?: number;
}): boolean {
  const ratio = opts.ratio ?? CONTEXT_COMPRESS_RATIO;
  return opts.storedChars + opts.injectedOverhead >= opts.softLimitChars * ratio;
}

export type ModelLike = Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName'>;

/** 标识上下文摘要消息，供展示层/后续适配器区分 */
export function isContextSummaryMessage(m: Pick<Message, 'meta' | 'content'>): boolean {
  if (m.meta?.kind === 'context-summary') return true;
  const c = String(m.content ?? '');
  return c.startsWith('【上下文摘要】') || c.startsWith('[Context summary]');
}
