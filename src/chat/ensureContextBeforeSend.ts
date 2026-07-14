import type { Message, ModelConfig } from '../types';
import { shouldCompressContext, estimateSessionChars } from '../utils/contextBudget';
import { resolveContextSoftLimitChars } from '../utils/inferContextWindow';
import { compressSessionContext, type CallModelFn } from '../utils/compressSessionContext';
import { useChatStore } from '../store/chatStore';
import { estimateInjectedPayloadOverheadChars } from './payloadBoundary';

export type EnsureContextBeforeSendResult = {
  priorMessages: Message[];
  didCompress: boolean;
};

function needsCompression(
  priorMessages: Message[],
  draftInput: string,
  model: ModelConfig,
  extras?: { webEnabled?: boolean; ragLikely?: boolean; workspaceLikely?: boolean }
): boolean {
  const soft = resolveContextSoftLimitChars(model);
  const overhead = estimateInjectedPayloadOverheadChars({
    webEnabled: extras?.webEnabled,
    ragLikely: extras?.ragLikely,
    workspaceLikely: extras?.workspaceLikely,
  });
  /** 用「软上限 − 注入开销」作为有效预算，避免存储层安全但 payload 超限 */
  const effectiveLimit = Math.max(soft - overhead, Math.floor(soft * 0.5));
  if (shouldCompressContext(priorMessages, draftInput, effectiveLimit, undefined, model)) {
    return true;
  }
  /** 双重确认：含开销的总量 */
  return estimateSessionChars(priorMessages, draftInput) + overhead >= soft * 0.95;
}

/**
 * 发送前统一上下文门禁：按 sessionId 压缩（若需要），写回 store，返回最新 prior。
 * 桌面发送 / 编辑重发 / 远端桥接共用，避免入口行为分叉。
 */
export async function ensureContextBeforeSend(opts: {
  sessionId: string;
  /** 压缩判定与摘要所用的历史（不含本轮即将发送的用户消息） */
  priorMessages: Message[];
  draftInput: string;
  model: ModelConfig;
  locale?: 'zh' | 'en';
  summaryTitle?: string;
  /**
   * 编辑重发：只压缩 source 之前的前缀，写回时保留 source 及之后消息。
   * 压缩后用该 id 在会话中定位，再切片得到 prior。
   */
  editSourceMessageId?: string;
  callModel?: CallModelFn;
  /** 发送时可能注入的额外上下文（联网/RAG/工作区），计入压缩门禁 */
  injectExtras?: { webEnabled?: boolean; ragLikely?: boolean; workspaceLikely?: boolean };
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
  } = opts;

  if (!needsCompression(priorMessages, draftInput, model, injectExtras)) {
    return { priorMessages, didCompress: false };
  }

  const chat = useChatStore.getState();
  chat.setCompressingContext(sessionId);
  try {
    const sourceIndex = editSourceMessageId
      ? (chat.sessions.find((s) => s.id === sessionId)?.messages.findIndex((m) => m.id === editSourceMessageId) ??
        -1)
      : -1;

    const replace =
      sourceIndex >= 0
        ? (sid: string, keepFromIndex: number, summaryMessage: Message) => {
            useChatStore
              .getState()
              .replaceMessagesPrefixBeforeIndex(sid, sourceIndex, keepFromIndex, summaryMessage);
          }
        : chat.replaceMessagesPrefix;

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

    const after = useChatStore.getState().sessions.find((s) => s.id === sessionId)?.messages;
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
    useChatStore.getState().clearCompressingForSession(sessionId);
  }
}
