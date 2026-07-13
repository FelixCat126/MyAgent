import type { Message } from '../types';
import type { ModelConfig } from '../types';
import { resolveContextSoftLimitChars } from './inferContextWindow';

/** @deprecated 仅作无模型时的回退；正常路径请用 resolveContextSoftLimitChars(model) */
export const CONTEXT_SOFT_LIMIT_CHARS = resolveContextSoftLimitChars(null);

/** 超过预算该比例则触发压缩 */
export const CONTEXT_COMPRESS_RATIO = 0.95;
/** 压缩后希望近期消息约占预算的比例 */
export const CONTEXT_KEEP_RECENT_RATIO = 0.4;
/** 摘要消息 content 前缀（可见） */
export const CONTEXT_SUMMARY_PREFIX = '【上下文摘要】';

export function estimateSessionChars(
  messages: Array<{ content?: string }>,
  draftInput = ''
): number {
  const msgLen = messages.reduce((acc, m) => acc + String(m.content ?? '').length, 0);
  return msgLen + String(draftInput ?? '').length;
}

export function shouldCompressContext(
  messages: Array<{ content?: string }>,
  draftInput = '',
  limit?: number,
  ratio = CONTEXT_COMPRESS_RATIO,
  model?: Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName'> | null
): boolean {
  if (messages.length < 4) return false;
  const soft = limit ?? resolveContextSoftLimitChars(model ?? null);
  return estimateSessionChars(messages, draftInput) >= soft * ratio;
}

/** 从末尾保留消息，使总字符约不超过 targetChars，且至少 keepMin 条 */
export function splitMessagesForCompression(
  messages: Message[],
  targetRecentChars?: number,
  keepMin = 6,
  softLimitChars?: number
): { older: Message[]; recent: Message[]; keepFromIndex: number } {
  const soft = softLimitChars ?? CONTEXT_SOFT_LIMIT_CHARS;
  const target =
    targetRecentChars ?? Math.floor(soft * CONTEXT_KEEP_RECENT_RATIO);
  if (messages.length === 0) {
    return { older: [], recent: [], keepFromIndex: 0 };
  }
  let keepFrom = messages.length;
  let recentChars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const len = String(messages[i]?.content ?? '').length;
    const wouldKeep = messages.length - i;
    if (wouldKeep > keepMin && recentChars + len > target) break;
    recentChars += len;
    keepFrom = i;
  }
  /** 至少丢掉一些才算压缩 */
  if (keepFrom <= 0) {
    return { older: [], recent: messages, keepFromIndex: 0 };
  }
  return {
    older: messages.slice(0, keepFrom),
    recent: messages.slice(keepFrom),
    keepFromIndex: keepFrom,
  };
}

export function buildCompressionPrompt(olderMessages: Message[]): Message[] {
  const transcript = olderMessages
    .map((m) => {
      const role =
        m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : m.role;
      const body = String(m.content ?? '').trim();
      if (!body) return '';
      const clipped = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
      return `${role}：${clipped}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      id: 'compress-system',
      role: 'system',
      content:
        '你是对话上下文压缩器。请把用户提供的较早聊天记录压缩成一段简洁中文摘要，保留：关键事实、已做决定、未完成任务、用户偏好、重要名词与数字。不要续写对话，不要回答其中的问题，只输出摘要正文。',
      timestamp: Date.now(),
      model: 'compress',
    },
    {
      id: 'compress-user',
      role: 'user',
      content: `请压缩以下较早对话：\n\n${transcript}`,
      timestamp: Date.now(),
      model: 'compress',
    },
  ];
}

export function parseCompressionSummary(raw: string, titlePrefix = CONTEXT_SUMMARY_PREFIX): string {
  let text = String(raw ?? '').trim();
  if (!text) text = '（较早对话已压缩，细节已省略。）';
  if (text.startsWith(titlePrefix)) return text;
  return `${titlePrefix}\n${text}`;
}

/** 本地降级：丢弃较早消息，仅保留 recent + 占位摘要 */
export function compressMessagesLocally(
  messages: Message[],
  summaryTitle = CONTEXT_SUMMARY_PREFIX,
  softLimitChars?: number
): { messages: Message[]; keepFromIndex: number; summaryMessage: Message } | null {
  const soft = softLimitChars ?? CONTEXT_SOFT_LIMIT_CHARS;
  const { older, recent, keepFromIndex } = splitMessagesForCompression(
    messages,
    undefined,
    6,
    soft
  );
  if (older.length === 0) return null;
  const summaryMessage: Message = {
    id: `ctx-summary-${Date.now()}`,
    role: 'assistant',
    content: parseCompressionSummary(
      `已省略较早的 ${older.length} 条消息（本地快速压缩）。近期对话仍完整保留。`,
      summaryTitle
    ),
    timestamp: Date.now(),
    model: 'context-compress',
  };
  return {
    messages: [summaryMessage, ...recent],
    keepFromIndex,
    summaryMessage,
  };
}
