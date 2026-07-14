import type { Message, ModelConfig } from '../types';

/** 单条消息送入模型前的硬截断（与预算层解耦；超出时静默截断） */
export const SANITIZE_MAX_CONTENT_CHARS = 80_000;

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
 * 估算 enrich 后可能额外注入的字符（RAG/工作区等粗估上限），
 * 用于发送前二次护栏：存储消息看似安全，但真实 payload 可能超预算。
 */
export function estimateInjectedPayloadOverheadChars(opts: {
  webEnabled?: boolean;
  ragLikely?: boolean;
  workspaceLikely?: boolean;
}): number {
  let n = 0;
  if (opts.webEnabled) n += 12_000;
  if (opts.ragLikely) n += 24_000;
  if (opts.workspaceLikely) n += 40_000;
  return n;
}

/** 发送前：存储 prior + draft + 注入开销 是否逼近产品软上限 */
export function shouldWarnPayloadNearLimit(opts: {
  storedChars: number;
  injectedOverhead: number;
  softLimitChars: number;
  ratio?: number;
}): boolean {
  const ratio = opts.ratio ?? 0.95;
  return opts.storedChars + opts.injectedOverhead >= opts.softLimitChars * ratio;
}

export type ModelLike = Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName'>;

/** 标识上下文摘要消息，供展示层/后续适配器区分 */
export function isContextSummaryMessage(m: Pick<Message, 'meta' | 'content'>): boolean {
  if (m.meta?.kind === 'context-summary') return true;
  const c = String(m.content ?? '');
  return c.startsWith('【上下文摘要】') || c.startsWith('[Context summary]');
}
