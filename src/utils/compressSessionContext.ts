import type { Message, ModelConfig } from '../types';
import {
  CONTEXT_SUMMARY_PREFIX,
  buildCompressionPrompt,
  compressMessagesLocally,
  parseCompressionSummary,
  splitMessagesForCompression,
} from './contextBudget';
import { resolveContextSoftLimitChars } from './inferContextWindow';

export type CompressSessionResult = {
  didCompress: boolean;
  messages: Message[];
};

/**
 * 用当前模型摘要较早消息并写回会话；失败则本地降级压缩。
 * 调用方负责 compressing UI 状态；本函数负责改写 messages。
 */
export async function compressSessionContext(opts: {
  sessionId: string;
  messages: Message[];
  model: ModelConfig;
  locale?: 'zh' | 'en';
  summaryTitle?: string;
  replaceMessagesPrefix: (
    sessionId: string,
    keepFromIndex: number,
    summaryMessage: Message
  ) => void;
}): Promise<CompressSessionResult> {
  const {
    sessionId,
    messages,
    model,
    locale = 'zh',
    summaryTitle = CONTEXT_SUMMARY_PREFIX,
    replaceMessagesPrefix,
  } = opts;

  const softLimit = resolveContextSoftLimitChars(model);
  const { older, recent, keepFromIndex } = splitMessagesForCompression(
    messages,
    undefined,
    6,
    softLimit
  );
  if (older.length === 0) {
    return { didCompress: false, messages };
  }

  let summaryBody = '';
  try {
    const promptMessages = buildCompressionPrompt(older);
    const response = await window.electron.callModel(
      promptMessages,
      {
        ...model,
        maxTokens: Math.min(model.maxTokens || 1024, 1024),
      },
      { locale, temperature: 0.2 }
    );
    summaryBody = typeof response?.content === 'string' ? response.content.trim() : '';
  } catch (e) {
    console.warn('[compressSessionContext] 模型摘要失败，降级本地压缩', e);
  }

  if (!summaryBody) {
    const local = compressMessagesLocally(messages, summaryTitle, softLimit);
    if (!local) return { didCompress: false, messages };
    replaceMessagesPrefix(sessionId, local.keepFromIndex, local.summaryMessage);
    return { didCompress: true, messages: local.messages };
  }

  const summaryMessage: Message = {
    id: `ctx-summary-${Date.now()}`,
    role: 'assistant',
    content: parseCompressionSummary(summaryBody, summaryTitle),
    timestamp: Date.now(),
    model: model.name || 'context-compress',
  };
  replaceMessagesPrefix(sessionId, keepFromIndex, summaryMessage);
  return {
    didCompress: true,
    messages: [summaryMessage, ...recent],
  };
}
