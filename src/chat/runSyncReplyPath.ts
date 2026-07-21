import type { Message, ModelConfig } from '../types';
import {
  fulfillDocumentArtifact,
  mergeAssistantFiles,
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

  const documentArtifactAssistantId = exportHint?.document ? `${Date.now()}-doc` : '';
  try {
    if (documentArtifactAssistantId) {
      ui.addMessage(sendSessionId, {
        id: documentArtifactAssistantId,
        role: 'assistant',
        content: '',
        exportHint: { ...exportHint!, status: 'generating' },
        timestamp: Date.now(),
        model: activeModel.name,
      });
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
    const assistantId = `${Date.now() + 1}-a`;
    ui.addMessage(sendSessionId, {
      id: assistantId,
      role: 'assistant',
      content: content0,
      ...(reasoningIn ? { reasoning: reasoningIn } : {}),
      ...(exportHint ? { exportHint } : {}),
      timestamp: Date.now(),
      model: activeModel.name,
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
    ui.addMessage(sendSessionId, {
      id: `${Date.now()}-a`,
      role: 'assistant',
      content: ui.t('chat.requestFailed') + msg,
      timestamp: Date.now(),
      model: activeModel.name,
    });
  } finally {
    ui.clearLoadingForSession(sendSessionId);
  }
}
