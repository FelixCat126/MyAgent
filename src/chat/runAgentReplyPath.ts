import type { Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { StreamingSpeechReader } from '../utils/streamingSpeech';
import { runAgentLoop } from '@/agent/agentRunner';
import { shouldEnterAgentReply } from '@/agent/shouldEnterAgentReply';
import { extractGenerateImageCalls, stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';
import { planImageIntent } from '../utils/imageIntentPlanner';
import {
  postProcessAssistantContent,
  imageReferencePathsFromFiles,
} from './imageGenAssist';
import { makeImageGenHooks } from './makeImageGenHooks';
import {
  syncImgGenUi,
  appendGeneratedImageToAssistant,
  mergeAssistantFiles,
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
    exportHint,
    isLocalImageFind,
    isWebBrowseTask,
  } = args;

  if (
    !shouldEnterAgentReply({
      userText: userMessage.content,
      exportDocument: Boolean(exportHint?.document),
    }).enter
  ) {
    return false;
  }

  const assistantId = `${Date.now() + 1}-a`;
  ui.streamingAssistantIdRef.current = assistantId;
  ui.streamingSessionIdRef.current = sendSessionId;
  ui.setStreamingTargetAssistantId(assistantId);
  ui.setIsStreaming(true);
  ui.addMessage(sendSessionId, {
    id: assistantId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    model: activeModel.name,
  });

  let pendingReasoningDelta = '';
  let reasoningFlushRaf = 0;
  const drainAgentReasoning = (): void => {
    if (reasoningFlushRaf !== 0) {
      window.cancelAnimationFrame(reasoningFlushRaf);
      reasoningFlushRaf = 0;
    }
    const merged = pendingReasoningDelta;
    pendingReasoningDelta = '';
    if (!merged) return;
    ui.appendReasoningToMessage(sendSessionId, assistantId, merged);
  };
  const queueAgentReasoning = (th: string): void => {
    if (!th) return;
    pendingReasoningDelta += th;
    if (reasoningFlushRaf !== 0) return;
    reasoningFlushRaf = window.requestAnimationFrame(() => {
      reasoningFlushRaf = 0;
      drainAgentReasoning();
    });
  };

  try {
    ui.streamCancelledByUserRef.current = false;
    const agentOut = await runAgentLoop({
      chatSessionId: sendSessionId,
      chainMessages: chainForModel,
      model: activeModel,
      userText: userMessage.content,
      locale: ui.locale,
      onThinkingDelta: queueAgentReasoning,
      shouldCancel: () => ui.streamCancelledByUserRef.current,
      onReplyContent: (text) => {
        ui.updateMessage(sendSessionId, assistantId, { content: text });
      },
    });
    drainAgentReasoning();
    if (agentOut.handled && agentOut.displayText !== undefined) {
      if (agentOut.reasoning) {
        const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
        const msg = sess?.messages.find((m) => m.id === assistantId);
        const priorReason = (msg?.reasoning ?? '').trim();
        if (!priorReason && agentOut.reasoning.trim()) {
          ui.appendReasoningToMessage(sendSessionId, assistantId, agentOut.reasoning);
        }
      }
      if (ui.consumeVoiceWakeReply()) {
        ui.speechReaderRef.current?.cancel();
        const reader = new StreamingSpeechReader(ui.locale, {
          onSpeakingChange: ui.setVoiceReplySpeaking,
        });
        ui.speechReaderRef.current = reader;
        void (async () => {
          await reader.start();
          const speakBody = stripGenerateImageArtifactsForDisplay(agentOut.displayText!).trim();
          if (speakBody) {
            reader.push(speakBody);
            reader.finish();
          }
        })();
      }
      const imageHooks = makeImageGenHooks({
        assistantId,
        syncImgGenUi: (v) => syncImgGenUi(ui, sendSessionId, v),
        imageGenCancelledRef: ui.imageGenCancelledRef,
        onImage: (image) => appendGeneratedImageToAssistant(ui, sendSessionId, assistantId, image),
      });
      const plannedIntent = planImageIntent({
        userText: userMessage.content,
        historyBeforeUser,
        assistantText: agentOut.displayText,
        toolCallCount: extractGenerateImageCalls(agentOut.displayText).length,
      });
      if (isLocalImageFind || isWebBrowseTask) {
        ui.updateMessage(sendSessionId, assistantId, {
          content: agentOut.displayText ?? '',
          files: mergeAssistantFiles(sendSessionId, assistantId, agentOut.exportFiles),
          imageGenProgress: undefined,
        });
      } else {
        const { content: c, files } = await postProcessAssistantContent(
          agentOut.displayText,
          activeModel,
          ui.inlineImageIndexRef.current,
          ui.setInlineImageIndex,
          {
            imageGenHooks: imageHooks,
            referenceImages: imageReferencePathsFromFiles(userMessage.files),
            userPromptContext: userMessage.content,
            plannedIntent,
            shouldCancel: () => ui.imageGenCancelledRef.current,
          }
        );
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
    drainAgentReasoning();
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
