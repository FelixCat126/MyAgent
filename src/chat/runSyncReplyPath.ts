import { useChatStore } from '../store/chatStore';
import { imageTaskWasCancelled, releaseImageTask, replyRunWasCancelled } from './imageTaskState';
import type { Message, ModelConfig } from '../types';
import { inferReplyExportHint } from '../utils/documentExportIntent';
import {
  fulfillDocumentArtifact,
  mergeAssistantFiles,
  markAssistantTaskError,
  resolveOrCreateAssistantBubble,
  runImagePostProcess,
  speakVoiceWakeReplyOnce,
} from './runModelReplyShared';
import type { RunModelReplyUi } from './runModelReplyTypes';
import { runVideoPostProcess } from './videoGenAssist';

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
  let replyAssistantId = '';
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
    if (replyRunWasCancelled(sendSessionId, userMessage.id)) return;
    if (exportHint?.document && response.truncated) {
      ui.updateMessage(sendSessionId, documentArtifactAssistantId, { content: response.content || ui.t('chat.fallbackReply'), exportHint: { ...exportHint, status: 'failed', error: '模型达到输出长度上限，正文尚未完整生成。请增加模型输出长度或分章节生成后重试。' } });
      return;
    }
    if (exportHint?.document && !response.content?.trim()) throw new Error('模型未返回文档正文，请重试。');
    const rawContent = response.content || '';
    const reasoningIn = typeof response.reasoning === 'string' ? response.reasoning.trim() : '';
    const content0 = rawContent.trim() ? rawContent : ui.t(reasoningIn ? 'chat.emptyAfterReasoning' : 'chat.fallbackReply');
    if (exportHint?.document) {
      await fulfillDocumentArtifact({
        ui,
        sendSessionId,
        assistantId: documentArtifactAssistantId,
        shouldCancel: () => replyRunWasCancelled(sendSessionId, userMessage.id),
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
    replyAssistantId = assistantId;
    speakVoiceWakeReplyOnce(ui, content0);
    const { content: c, files, taskError } = await runImagePostProcess({
      ui,
      sendSessionId,
      assistantId,
      rawText: content0,
      userMessage,
      activeModel,
      historyBeforeUser,
    });
    /** 内容驱动导出：AI 回复含文档/表格特征时自动给出导出格式（用户不必明说"下载"） */
    const replyHint = inferReplyExportHint(c, userMessage.content);
    const effectiveExportHint = exportHint ?? replyHint;
    const mergedFiles = mergeAssistantFiles(sendSessionId, assistantId, files);
    if (!rawContent.trim() && !mergedFiles?.length && !taskError) markAssistantTaskError(ui, sendSessionId, assistantId, '模型返回空回答');
    ui.updateMessage(sendSessionId, assistantId, {
      content: c,
      ...(reasoningIn ? { reasoning: reasoningIn } : {}),
      ...(effectiveExportHint ? { exportHint: effectiveExportHint } : {}),
      files: mergedFiles,
      imageGenProgress: undefined,
    });
    void runVideoPostProcess({ ui, sendSessionId, assistantId, rawText: c, userMessage, activeModel, historyBeforeUser, currentMsg: useChatStore.getState().sessions.find(s => s.id === sendSessionId)?.messages.find(m => m.id === assistantId) }).catch(error => console.warn('[videoGenAssist]', error));
  } catch (error) {
    if (replyRunWasCancelled(sendSessionId, userMessage.id)) return;
    const msg = error instanceof Error ? error.message : String(error);
    if (documentArtifactAssistantId) {
      ui.updateMessage(sendSessionId, documentArtifactAssistantId, {
        content: ui.t('chat.requestFailed') + msg,
        exportHint: { ...exportHint, status: 'failed', error: msg },
      });
      return;
    }
    resolveOrCreateAssistantBubble(ui, sendSessionId, `${Date.now()}-a`, {
      modelName: activeModel.name,
      content: ui.t('chat.requestFailed') + msg,
    });
    const failed=useChatStore.getState().sessions.find(s=>s.id===sendSessionId)?.messages.at(-1);
    if(failed)ui.updateMessage(sendSessionId,failed.id,{meta:{taskError:msg}});
  } finally {
    if (!imageTaskWasCancelled(replyAssistantId) && !replyRunWasCancelled(sendSessionId, userMessage.id)) ui.clearLoadingForSession(sendSessionId);
    releaseImageTask(replyAssistantId);
  }
}
