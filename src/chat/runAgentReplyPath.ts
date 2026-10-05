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
import { runVideoPostProcess } from './videoGenAssist';

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
      hasDataAttachments: [...historyBeforeUser,userMessage].filter(message=>message.role==='user').some(message=>message.files?.some(file=>/\.(xlsx|csv|tsv)$/i.test(file.name))),
    }).enter
  ) {
    return false;
  }

  const assistantId = beginAssistantStream(ui, sendSessionId, {
    assistantId: `${Date.now() + 1}-a`,
    modelName: activeModel.name,
  });

  const reasoningStream = createAnimStream(
    sendSessionId,
    assistantId,
    ui.appendReasoningToMessage,
    { pace: 'reasoning' },
  );

  let answerStream:ReturnType<typeof createAnimStream>|undefined;
  const cancelAnimationPoll=window.setInterval(()=>{if(ui.streamCancelledByUserRef.current){reasoningStream.cancel();answerStream?.cancel();}},100);
  try {
    const agentOut = await runAgentLoop({
      chatSessionId: sendSessionId,
      chainMessages: chainForModel,
      model: activeModel,
      userText: userMessage.content,
      locale: ui.locale,
      onThinkingDelta: reasoningStream.push,
      shouldCancel: () => ui.streamCancelledByUserRef.current,

    });
    await reasoningStream.finish();
    if (agentOut.handled && agentOut.displayText !== undefined) {
      if (agentOut.reasoning) {
        const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
        const msg = sess?.messages.find((m) => m.id === assistantId);
        const priorReason = (msg?.reasoning ?? '').trim();
        if (!priorReason && agentOut.reasoning.trim()) {
          ui.appendReasoningToMessage(sendSessionId, assistantId, agentOut.reasoning);
        }
      }
      if(ui.streamCancelledByUserRef.current)return true;
      // Tool rounds and answer validation finish before this text is safe to show.
      // Replay the already-complete answer briskly instead of adding a second
      // full-length wait at the normal live-model pace.
      answerStream=createAnimStream(sendSessionId,assistantId,ui.appendToMessage,{pace:'completed'});
      answerStream.push(agentOut.displayText);
      await answerStream.finish();
      if(ui.streamCancelledByUserRef.current)return true;
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
          generatedFiles: agentOut.exportFiles,
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
      const currentMsg = useChatStore.getState().sessions.find(s => s.id === sendSessionId)?.messages.find(m => m.id === assistantId);
      void runVideoPostProcess({ ui, sendSessionId, assistantId, rawText: currentMsg?.content ?? agentOut.displayText, userMessage, activeModel, historyBeforeUser, currentMsg }).catch(error => console.warn('[videoGenAssist]', error));
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
      meta: cancelled ? undefined : {taskError:agentErr instanceof Error?agentErr.message:String(agentErr)},
      content: cancelled
        ? ui.t('chat.stoppedBanner')
        : ui.t('chat.requestFailed') + (agentErr instanceof Error ? agentErr.message : String(agentErr)),
    });
    ui.clearLoadingForSession(sendSessionId);
    return true;
  } finally {
    window.clearInterval(cancelAnimationPoll);
    ui.setIsStreaming(false);
    ui.streamingAssistantIdRef.current = null;
    ui.streamingSessionIdRef.current = null;
    ui.setStreamingTargetAssistantId(null);
    ui.streamCancelledByUserRef.current = false;
  }

  return false;
}
