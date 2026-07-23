import type { Message, ModelConfig } from '../types';
import {
  fulfillDocumentArtifact,
  mergeAssistantFiles,
  resolveOrCreateAssistantBubble,
  runImagePostProcess,
  speakVoiceWakeReplyOnce,
} from './runModelReplyShared';
import type { RunModelReplyUi } from './runModelReplyTypes';

export type RunSyncReplyPathArgs = {
  ui: RunModelReplyUi;
  sendSessionId: string;
  historyBeforeUser: Message[];
  userMessage: Message;
  activeModel: ModelConfig;
  plainMessages: Message[];
  plainModel: ModelConfig;
  exportHint: Message['exportHint'];
};

export async function runSyncReplyPath(args: RunSyncReplyPathArgs): Promise<void> {
  const {
    ui,
    sendSessionId,
    historyBeforeUser,
    userMessage,
    activeModel,
    plainMessages,
    plainModel,
    exportHint,
  } = args;

  let documentArtifactAssistantId = '';
  try {
    if (exportHint?.document) {
      documentArtifactAssistantId = resolveOrCreateAssistantBubble(
        ui,
        sendSessionId,
        `${Date.now()}-doc`,
        {
          modelName: activeModel.name,
          exportHint: { ...exportHint, status: 'generating' },
        }
      );
    }
    const response = await window.electron.callModel(plainMessages, plainModel, { locale: ui.locale });
    const content0 = response.content || ui.t('chat.fallbackReply');
    const reasoningIn = typeof response.reasoning === 'string' ? response.reasoning.trim() : '';
    if (exportHint?.document) {
      await fulfillDocumentArtifact({
        ui,
        sendSessionId,
        assistantId: documentArtifactAssistantId,
        rawText: content0,
        userText: userMessage.content,
        exportHint,
        extraUpdate: reasoningIn ? { reasoning: reasoningIn } : undefined,
      });
      return;
    }
    const assistantId = resolveOrCreateAssistantBubble(ui, sendSessionId, `${Date.now() + 1}-a`, {
      modelName: activeModel.name,
      content: content0,
      ...(reasoningIn ? { reasoning: reasoningIn } : {}),
      ...(exportHint ? { exportHint } : {}),
    });
    speakVoiceWakeReplyOnce(ui, content0);
    const { content: c, files } = await runImagePostProcess({
      ui,
      sendSessionId,
      assistantId,
      rawText: content0,
      userMessage,
      activeModel,
      historyBeforeUser,
    });
    ui.updateMessage(sendSessionId, assistantId, {
      content: c,
      ...(reasoningIn ? { reasoning: reasoningIn } : {}),
      ...(exportHint ? { exportHint } : {}),
      files: mergeAssistantFiles(sendSessionId, assistantId, files),
      imageGenProgress: undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (documentArtifactAssistantId) {
      ui.updateMessage(sendSessionId, documentArtifactAssistantId, {
        content: ui.t('chat.requestFailed') + msg,
      });
      return;
    }
    resolveOrCreateAssistantBubble(ui, sendSessionId, `${Date.now()}-a`, {
      modelName: activeModel.name,
      content: ui.t('chat.requestFailed') + msg,
    });
  } finally {
    ui.clearLoadingForSession(sendSessionId);
  }
}
