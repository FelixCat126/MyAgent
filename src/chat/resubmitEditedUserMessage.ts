import type { Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { ensureContextBeforeSend } from './ensureContextBeforeSend';
import {
  addFullTextBypassIfNeeded,
  resolveInjectExtras,
  tryClaimSessionSend,
  type RunModelReplyFn,
} from './sendPipeline';

export type ResubmitEditedResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'busy' | 'session-missing' | 'message-missing' | 'not-user' | 'empty';
    };

/**
 * 编辑用户消息后重发（桌面 / 远端共用）。
 * 调用方负责 UI（如关闭编辑态）；本函数负责占坑、压缩、改写消息、bypass/跑模型。
 * 失败时会 clearLoading；业务错误以 result.ok=false 返回，不会 throw（除 runModelReply 内部异常外）。
 */
export async function resubmitEditedUserMessage(opts: {
  sessionId: string;
  messageId: string;
  textContent: string;
  model: ModelConfig;
  locale: 'zh' | 'en';
  summaryTitle: string;
  /** 会话级联网开关（已算好的 effective） */
  webEnabled: boolean;
  runModelReply: RunModelReplyFn;
}): Promise<ResubmitEditedResult> {
  const textContent = opts.textContent.trim();
  if (!textContent) return { ok: false, reason: 'empty' };

  const chat = useChatStore.getState();
  const sess = chat.sessions.find((s) => s.id === opts.sessionId);
  if (!sess) return { ok: false, reason: 'session-missing' };

  const sourceIndex = sess.messages.findIndex((m) => m.id === opts.messageId);
  if (sourceIndex < 0) return { ok: false, reason: 'message-missing' };
  const sourceMessage = sess.messages[sourceIndex];
  if (sourceMessage.role !== 'user') return { ok: false, reason: 'not-user' };

  if (!tryClaimSessionSend(opts.sessionId)) return { ok: false, reason: 'busy' };

  let priorMessages = sess.messages.slice(0, sourceIndex);
  const staleMessageIds = sess.messages.slice(sourceIndex + 1).map((m) => m.id);

  try {
    const ensured = await ensureContextBeforeSend({
      sessionId: opts.sessionId,
      priorMessages,
      draftInput: textContent,
      model: opts.model,
      locale: opts.locale,
      summaryTitle: opts.summaryTitle,
      editSourceMessageId: opts.messageId,
      injectExtras: resolveInjectExtras({ webEnabled: opts.webEnabled }),
    });
    priorMessages = ensured.priorMessages;

    const latest =
      useChatStore.getState().sessions.find((s) => s.id === opts.sessionId)?.messages ?? sess.messages;
    const latestSourceIndex = latest.findIndex((m) => m.id === opts.messageId);
    if (latestSourceIndex < 0) {
      useChatStore.getState().clearLoadingForSession(opts.sessionId);
      return { ok: false, reason: 'message-missing' };
    }
    priorMessages = latest.slice(0, latestSourceIndex);

    const userMessage: Message = {
      ...sourceMessage,
      role: 'user',
      content: textContent,
      timestamp: Date.now(),
      model: opts.model.name,
    };

    const staleIds =
      staleMessageIds.length > 0
        ? latest.slice(latestSourceIndex + 1).map((m) => m.id)
        : [];

    useChatStore.getState().resubmitUserMessageAtomically(
      opts.sessionId,
      opts.messageId,
      {
        content: textContent,
        timestamp: userMessage.timestamp,
        model: opts.model.name,
      },
      staleIds
    );

    if (
      !addFullTextBypassIfNeeded({
        sessionId: opts.sessionId,
        modelName: opts.model.name,
        textContent,
        hasAttachments: Boolean(sourceMessage.files?.length),
      })
    ) {
      await opts.runModelReply(opts.sessionId, priorMessages, userMessage, opts.model);
    }
    return { ok: true };
  } catch (e) {
    useChatStore.getState().clearLoadingForSession(opts.sessionId);
    throw e;
  }
}
