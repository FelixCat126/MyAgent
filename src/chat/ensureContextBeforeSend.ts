import type { Message, ModelConfig } from '../types';
import {
  canPerformCompressionSplit,
  estimateSessionChars,
  shouldCompressContext,
} from '../utils/contextBudget';
import { resolveContextSoftLimitChars } from '../utils/inferContextWindow';
import { compressSessionContext, type CallModelFn } from '../utils/compressSessionContext';
import { useChatStore } from '../store/chatStore';
import { estimateInjectedPayloadOverheadChars } from './payloadBoundary';
import type { InjectExtras } from './sendPipeline';

export type EnsureContextBeforeSendResult = {
  priorMessages: Message[];
  didCompress: boolean;
};

export type EnsureContextStoreApi = {
  setCompressingContext: (sessionId: string | null) => void;
  clearCompressingForSession: (sessionId: string) => void;
  getSessionMessages: (sessionId: string) => Message[] | undefined;
  replaceMessagesPrefix: (
    sessionId: string,
    keepFromIndex: number,
    summaryMessage: Message
  ) => void;
  replaceMessagesPrefixBeforeIndex: (
    sessionId: string,
    beforeIndex: number,
    keepFromIndex: number,
    summaryMessage: Message
  ) => void;
};

function defaultStoreApi(): EnsureContextStoreApi {
  return {
    setCompressingContext: (id) => useChatStore.getState().setCompressingContext(id),
    clearCompressingForSession: (id) => useChatStore.getState().clearCompressingForSession(id),
    getSessionMessages: (id) =>
      useChatStore.getState().sessions.find((s) => s.id === id)?.messages,
    replaceMessagesPrefix: (...args) => useChatStore.getState().replaceMessagesPrefix(...args),
    replaceMessagesPrefixBeforeIndex: (...args) =>
      useChatStore.getState().replaceMessagesPrefixBeforeIndex(...args),
  };
}

function needsCompression(
  priorMessages: Message[],
  draftInput: string,
  model: ModelConfig,
  extras?: InjectExtras
): boolean {
  if (priorMessages.length < 4) return false;
  const soft = resolveContextSoftLimitChars(model);
  const overhead = estimateInjectedPayloadOverheadChars({
    webEnabled: extras?.webEnabled,
    ragLikely: extras?.ragLikely,
    workspaceLikely: extras?.workspaceLikely,
    ragMaxChars: extras?.ragMaxChars,
    workspaceMaxChars: extras?.workspaceMaxChars,
  });
  const effectiveLimit = Math.max(soft - overhead, Math.floor(soft * 0.5));
  const overBudget =
    shouldCompressContext(priorMessages, draftInput, effectiveLimit, undefined, model) ||
    estimateSessionChars(priorMessages, draftInput) + overhead >= soft * 0.95;
  if (!overBudget) return false;
  /** 与 compressSessionContext 可行性对齐，避免空转压缩 UI */
  return canPerformCompressionSplit(priorMessages, soft);
}

/**
 * 发送前统一上下文门禁：按 sessionId 压缩（若需要），写回 store，返回最新 prior。
 * store 可注入以便单测；默认走 chatStore。
 */
export async function ensureContextBeforeSend(opts: {
  sessionId: string;
  priorMessages: Message[];
  draftInput: string;
  model: ModelConfig;
  locale?: 'zh' | 'en';
  summaryTitle?: string;
  editSourceMessageId?: string;
  callModel?: CallModelFn;
  injectExtras?: InjectExtras;
  store?: EnsureContextStoreApi;
}): Promise<EnsureContextBeforeSendResult> {
  const {
    sessionId,
    priorMessages,
    draftInput,
    model,
    locale = 'zh',
    summaryTitle,
    editSourceMessageId,
    callModel,
    injectExtras,
    store: storeIn,
  } = opts;

  if (!needsCompression(priorMessages, draftInput, model, injectExtras)) {
    return { priorMessages, didCompress: false };
  }

  const store = storeIn ?? defaultStoreApi();
  store.setCompressingContext(sessionId);
  try {
    const msgs = store.getSessionMessages(sessionId) ?? priorMessages;
    const sourceIndex = editSourceMessageId
      ? msgs.findIndex((m) => m.id === editSourceMessageId)
      : -1;

    const replace =
      sourceIndex >= 0
        ? (sid: string, keepFromIndex: number, summaryMessage: Message) => {
            store.replaceMessagesPrefixBeforeIndex(
              sid,
              sourceIndex,
              keepFromIndex,
              summaryMessage
            );
          }
        : store.replaceMessagesPrefix;

    const compressed = await compressSessionContext({
      sessionId,
      messages: priorMessages,
      model,
      locale,
      summaryTitle,
      replaceMessagesPrefix: replace,
      callModel,
    });

    if (!compressed.didCompress) {
      return { priorMessages, didCompress: false };
    }

    const after = store.getSessionMessages(sessionId);
    if (editSourceMessageId && after) {
      const srcIdx = after.findIndex((m) => m.id === editSourceMessageId);
      if (srcIdx >= 0) {
        return { priorMessages: after.slice(0, srcIdx), didCompress: true };
      }
    }

    return {
      priorMessages: after ?? compressed.messages,
      didCompress: true,
    };
  } finally {
    store.clearCompressingForSession(sessionId);
  }
}
