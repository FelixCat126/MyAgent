import type { Message, ModelConfig } from '../types';
import {
  CONTEXT_SUMMARY_PREFIX,
  buildCompressionPrompt,
  compressMessagesLocally,
  createContextSummaryMessage,
  parseCompressionSummary,
  splitMessagesForCompression,
} from './contextBudget';
import { resolveContextSoftLimitChars } from './inferContextWindow';

export type CompressSessionResult = {
  didCompress: boolean;
  messages: Message[];
};

export type CallModelFn = (
  messages: Message[],
  config: ModelConfig,
  options?: { locale?: 'zh' | 'en'; temperature?: number }
) => Promise<{ content?: string }>;

/**
 * 用当前模型摘要较早消息并写回会话；失败则本地降级压缩。
 * callModel 可注入（默认 window.electron.callModel），便于测试与解耦。
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
  callModel?: CallModelFn;
}): Promise<CompressSessionResult> {
  const {
    sessionId,
    messages,
    model,
    locale = 'zh',
    summaryTitle = CONTEXT_SUMMARY_PREFIX,
    replaceMessagesPrefix,
    callModel,
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
    const promptMessages = buildCompressionPrompt(older, locale);
    const invoke: CallModelFn =
      callModel ??
      ((msgs, cfg, options) => window.electron.callModel(msgs, cfg, options));
    const response = await invoke(
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

  const summaryMessage = createContextSummaryMessage(
    parseCompressionSummary(summaryBody, summaryTitle),
    model.name || 'context-compress'
  );
  replaceMessagesPrefix(sessionId, keepFromIndex, summaryMessage);
  return {
    didCompress: true,
    messages: [summaryMessage, ...recent],
  };
}
