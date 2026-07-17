import type { Message, ModelConfig } from '../types';
import { StreamingSpeechReader } from '../utils/streamingSpeech';
import { extractGenerateImageCalls, stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';
import { planImageIntent } from '../utils/imageIntentPlanner';
import {
  documentArtifactBaseName,
  documentArtifactBaseNameFromContent,
  documentExportFormatsFromHint,
} from '../utils/documentExportIntent';
import {
  postProcessAssistantContent,
  imageReferencePathsFromFiles,
  createDocumentArtifactsFromMarkdown,
} from './imageGenAssist';
import { makeImageGenHooks } from './makeImageGenHooks';
import {
  syncImgGenUi,
  appendGeneratedImageToAssistant,
  mergeAssistantFiles,
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
    const reasoningIn =
      typeof (response as { reasoning?: unknown }).reasoning === 'string'
        ? String((response as { reasoning?: string }).reasoning).trim()
        : '';
    if (exportHint?.document) {
      const artifactBody = stripGenerateImageArtifactsForDisplay(content0).trim();
      const artifactFiles = await createDocumentArtifactsFromMarkdown(
        artifactBody,
        documentExportFormatsFromHint(exportHint),
        documentArtifactBaseNameFromContent(
          artifactBody,
          documentArtifactBaseName(userMessage.content)
        )
      );
      ui.updateMessage(sendSessionId, documentArtifactAssistantId, {
        content: artifactFiles.length
          ? ui.t('chat.documentReady')
          : ui.t('chat.documentWriteFailed'),
        ...(reasoningIn ? { reasoning: reasoningIn } : {}),
        exportHint,
        files: artifactFiles.length ? artifactFiles : undefined,
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
    if (ui.consumeVoiceWakeReply()) {
      ui.speechReaderRef.current?.cancel();
      const reader = new StreamingSpeechReader(ui.locale, {
        onSpeakingChange: ui.setVoiceReplySpeaking,
      });
      ui.speechReaderRef.current = reader;
      void (async () => {
        await reader.start();
        const speakBody = stripGenerateImageArtifactsForDisplay(content0).trim();
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
      assistantText: content0,
      toolCallCount: extractGenerateImageCalls(content0).length,
    });
    const { content: c, files } = await postProcessAssistantContent(
      content0,
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
