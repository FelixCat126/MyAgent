import type { Message } from '../types';
import type { ModelConfig } from '../types';
import {
  PRODUCT_CONTEXT_SOFT_LIMIT_CHARS,
  resolveContextSoftLimitChars,
} from './inferContextWindow';

/** @deprecated 请用 PRODUCT_CONTEXT_SOFT_LIMIT_CHARS；保留别名以免旧引用断裂 */
export const CONTEXT_SOFT_LIMIT_CHARS = PRODUCT_CONTEXT_SOFT_LIMIT_CHARS;

/** 超过预算该比例则触发压缩 */
export const CONTEXT_COMPRESS_RATIO = 0.95;
/** 压缩后希望近期消息约占预算的比例 */
export const CONTEXT_KEEP_RECENT_RATIO = 0.4;
/** 摘要消息 content 前缀（可见） */
export const CONTEXT_SUMMARY_PREFIX = '【上下文摘要】';
/** 单附件计入预算的字符上限（避免按整文件 size 把进度条打满） */
const ATTACHMENT_CHARS_CAP = 50_000;

export type EstimableMessage = {
  content?: string;
  reasoning?: string;
  files?: Array<{ name?: string; size?: number; type?: string }>;
  meta?: Message['meta'];
};

/** 单条消息对上下文压力的粗估（content + reasoning + 附件名/体积启发式） */
export function estimateMessageChars(m: EstimableMessage): number {
  let n = String(m.content ?? '').length + String(m.reasoning ?? '').length;
  for (const f of m.files ?? []) {
    n += String(f.name ?? '').length;
    const size = typeof f.size === 'number' && Number.isFinite(f.size) ? Math.max(0, f.size) : 0;
    const isImage = String(f.type ?? '').startsWith('image/');
    /** 图片按较小常数估；文本附件按 size 封顶累加 */
    n += isImage ? Math.min(size, 8_000) : Math.min(size, ATTACHMENT_CHARS_CAP);
  }
  return n;
}

export function estimateSessionChars(
  messages: EstimableMessage[],
  draftInput = ''
): number {
  const msgLen = messages.reduce((acc, m) => acc + estimateMessageChars(m), 0);
  return msgLen + String(draftInput ?? '').length;
}

export function shouldCompressContext(
  messages: EstimableMessage[],
  draftInput = '',
  limit?: number,
  ratio = CONTEXT_COMPRESS_RATIO,
  model?: Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName'> | null
): boolean {
  if (messages.length < 4) return false;
  const soft = limit ?? resolveContextSoftLimitChars(model ?? null);
  return estimateSessionChars(messages, draftInput) >= soft * ratio;
}

/** 进度条「满格」对应的字符数 = 压缩触发线（soft * ratio），与发送前门禁对齐 */
export function resolveContextProgressFullChars(
  model?: Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName'> | null,
  ratio = CONTEXT_COMPRESS_RATIO
): number {
  return Math.floor(resolveContextSoftLimitChars(model ?? null) * ratio);
}

/** 从末尾保留消息，使总字符约不超过 targetChars，且至少 keepMin 条 */
export function splitMessagesForCompression(
  messages: Message[],
  targetRecentChars?: number,
  keepMin = 6,
  softLimitChars?: number
): { older: Message[]; recent: Message[]; keepFromIndex: number } {
  const soft = softLimitChars ?? PRODUCT_CONTEXT_SOFT_LIMIT_CHARS;
  const target =
    targetRecentChars ?? Math.floor(soft * CONTEXT_KEEP_RECENT_RATIO);
  if (messages.length === 0) {
    return { older: [], recent: [], keepFromIndex: 0 };
  }
  let keepFrom = messages.length;
  let recentChars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const len = estimateMessageChars(messages[i] ?? {});
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

export function buildCompressionPrompt(
  olderMessages: Message[],
  locale: 'zh' | 'en' = 'zh'
): Message[] {
  const roleLabel = (role: Message['role']): string => {
    if (locale === 'en') {
      if (role === 'user') return 'User';
      if (role === 'assistant') return 'Assistant';
      if (role === 'system') return 'System';
      return role;
    }
    if (role === 'user') return '用户';
    if (role === 'assistant') return '助手';
    if (role === 'system') return '系统';
    return role;
  };

  const transcript = olderMessages
    .map((m) => {
      const body = String(m.content ?? '').trim();
      if (!body) return '';
      const clipped = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
      return `${roleLabel(m.role)}：${clipped}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const systemContent =
    locale === 'en'
      ? 'You are a conversation context compressor. Compress the earlier chat into a concise English summary. Keep: key facts, decisions, unfinished tasks, user preferences, important names and numbers. Do not continue the dialogue or answer questions in it—output only the summary body.'
      : '你是对话上下文压缩器。请把用户提供的较早聊天记录压缩成一段简洁中文摘要，保留：关键事实、已做决定、未完成任务、用户偏好、重要名词与数字。不要续写对话，不要回答其中的问题，只输出摘要正文。';

  const userContent =
    locale === 'en'
      ? `Compress the earlier conversation below:\n\n${transcript}`
      : `请压缩以下较早对话：\n\n${transcript}`;

  return [
    {
      id: 'compress-system',
      role: 'system',
      content: systemContent,
      timestamp: Date.now(),
      model: 'compress',
    },
    {
      id: 'compress-user',
      role: 'user',
      content: userContent,
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

export function createContextSummaryMessage(content: string, modelName: string): Message {
  return {
    id: `ctx-summary-${Date.now()}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    model: modelName,
    meta: { kind: 'context-summary' },
  };
}

/** 本地降级：丢弃较早消息，仅保留 recent + 占位摘要 */
export function compressMessagesLocally(
  messages: Message[],
  summaryTitle = CONTEXT_SUMMARY_PREFIX,
  softLimitChars?: number
): { messages: Message[]; keepFromIndex: number; summaryMessage: Message } | null {
  const soft = softLimitChars ?? PRODUCT_CONTEXT_SOFT_LIMIT_CHARS;
  const { older, recent, keepFromIndex } = splitMessagesForCompression(
    messages,
    undefined,
    6,
    soft
  );
  if (older.length === 0) return null;
  const summaryMessage = createContextSummaryMessage(
    parseCompressionSummary(
      `已省略较早的 ${older.length} 条消息（本地快速压缩）。近期对话仍完整保留。`,
      summaryTitle
    ),
    'context-compress'
  );
  return {
    messages: [summaryMessage, ...recent],
    keepFromIndex,
    summaryMessage,
  };
}
