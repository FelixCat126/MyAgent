import type { Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { runAgentLoop } from '@/agent/agentRunner';
import { shouldEnterAgentReply } from '@/agent/shouldEnterAgentReply';
import {
  createAnimStream,
  beginAssistantStream,
  mergeAssistantFiles,
  runImagePostProcess,
  speakVoiceWakeReplyOnce,
} from './runModelReplyShared';
import type { RunModelReplyUi } from './runModelReplyTypes';

export type RunAgentReplyPathArgs = {
  ui: RunModelReplyUi;
  sendSessionId: string;
  historyBeforeUser: Message[];
  userMessage: Message;
  activeModel: ModelConfig;
  chainForModel: Message[];
  exportHint: Message['exportHint'];
  isLocalImageFind: boolean;
  isWebBrowseTask: boolean;
};

/** @returns true 表示已处理完毕，调用方应直接 return */
export async function runAgentReplyPath(args: RunAgentReplyPathArgs): Promise<boolean> {
  const {
    ui,
    sendSessionId,
    historyBeforeUser,
    userMessage,
    activeModel,
    chainForModel,
    isLocalImageFind,
    isWebBrowseTask,
  } = args;

  if (
    !shouldEnterAgentReply({
      userText: userMessage.content,
      exportDocument: Boolean(args.exportHint?.document),
    }).enter
  ) {
    return false;
  }

  const assistantId = `${Date.now() + 1}-a`;
  beginAssistantStream(ui, sendSessionId, { assistantId, modelName: activeModel.name });

  const reasoningStream = createAnimStream(sendSessionId, assistantId, ui.appendReasoningToMessage);

  try {
    const agentOut = await runAgentLoop({
      chatSessionId: sendSessionId,
      chainMessages: chainForModel,
      model: activeModel,
      userText: userMessage.content,
      locale: ui.locale,
      onThinkingDelta: reasoningStream.push,
      shouldCancel: () => ui.streamCancelledByUserRef.current,
      onReplyContent: (text) => {
        ui.updateMessage(sendSessionId, assistantId, { content: text });
      },
    });
    reasoningStream.flush();
    if (agentOut.handled && agentOut.displayText !== undefined) {
      if (agentOut.reasoning) {
        const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
        const msg = sess?.messages.find((m) => m.id === assistantId);
        const priorReason = (msg?.reasoning ?? '').trim();
        if (!priorReason && agentOut.reasoning.trim()) {
          ui.appendReasoningToMessage(sendSessionId, assistantId, agentOut.reasoning);
        }
      }
      speakVoiceWakeReplyOnce(ui, agentOut.displayText);
      if (isLocalImageFind || isWebBrowseTask) {
        ui.updateMessage(sendSessionId, assistantId, {
          content: agentOut.displayText ?? '',
          files: mergeAssistantFiles(sendSessionId, assistantId, agentOut.exportFiles),
          imageGenProgress: undefined,
        });
      } else {
        const { content: c, files } = await runImagePostProcess({
          ui,
          sendSessionId,
          assistantId,
          rawText: agentOut.displayText,
          userMessage,
          activeModel,
          historyBeforeUser,
        });
        ui.updateMessage(sendSessionId, assistantId, {
          content: c,
          files: mergeAssistantFiles(sendSessionId, assistantId, [
            ...(files ?? []),
            ...(agentOut.exportFiles ?? []),
          ]),
          imageGenProgress: undefined,
        });
      }
      ui.setIsStreaming(false);
      ui.streamingAssistantIdRef.current = null;
      ui.streamingSessionIdRef.current = null;
      ui.setStreamingTargetAssistantId(null);
      ui.clearLoadingForSession(sendSessionId);
      return true;
    }
  } catch (agentErr) {
    console.error('[Agent]', agentErr);
    reasoningStream.flush();
    const cancelled =
      ui.streamCancelledByUserRef.current ||
      (agentErr instanceof Error &&
        (agentErr.message === 'AGENT_CANCELLED' ||
          (agentErr as Error & { code?: string }).code === 'AGENT_CANCELLED'));
    ui.updateMessage(sendSessionId, assistantId, {
      content: cancelled
        ? ui.t('chat.stoppedBanner')
        : ui.t('chat.requestFailed') + (agentErr instanceof Error ? agentErr.message : String(agentErr)),
    });
    ui.clearLoadingForSession(sendSessionId);
    return true;
  } finally {
    ui.setIsStreaming(false);
    ui.streamingAssistantIdRef.current = null;
    ui.streamingSessionIdRef.current = null;
    ui.setStreamingTargetAssistantId(null);
    ui.streamCancelledByUserRef.current = false;
  }

  return false;
}
