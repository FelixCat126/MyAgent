import type { Message, ModelConfig, FileInfo } from '../types';
import { useChatStore } from '../store/chatStore';
import { useSettingStore } from '../store/settingStore';
import { StreamingSpeechReader } from '../utils/streamingSpeech';
import { canUseSseStream } from '../utils/chatModelPolicy';
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
  createAnimStream,
  withStreamLifecycle,
} from './runModelReplyShared';
import type { RunModelReplyUi } from './runModelReplyTypes';

export type RunStreamReplyPathArgs = {
  ui: RunModelReplyUi;
  sendSessionId: string;
  historyBeforeUser: Message[];
  userMessage: Message;
  activeModel: ModelConfig;
  plainMessages: Message[];
  plainModel: ModelConfig;
  exportHint: Message['exportHint'];
};

/** @returns true 表示已启动流式路径，调用方应直接 return */
export function runStreamReplyPath(args: RunStreamReplyPathArgs): boolean {
  const { activeModel, exportHint } = args;

  if (exportHint?.document && canUseSseStream(activeModel)) {
    runDocumentStreamReply(args);
    return true;
  }

  const useStream =
    !exportHint?.document &&
    useSettingStore.getState().streamResponses &&
    canUseSseStream(activeModel);

  if (useStream) {
    runSseStreamReply(args);
    return true;
  }

  return false;
}

function runDocumentStreamReply(args: RunStreamReplyPathArgs): void {
  const { ui, sendSessionId, userMessage, activeModel, plainMessages, plainModel, exportHint } = args;
  if (!exportHint) return;

  ui.streamHadErrorRef.current = false;
  ui.streamCancelledByUserRef.current = false;
  const assistantId = `${Date.now()}-doc`;
  let artifactBuffer = '';
  ui.streamingAssistantIdRef.current = assistantId;
  ui.streamingSessionIdRef.current = sendSessionId;
  ui.setStreamingTargetAssistantId(assistantId);
  ui.setIsStreaming(true);
  ui.addMessage(sendSessionId, {
    id: assistantId,
    role: 'assistant',
    content: '',
    exportHint: { ...exportHint, status: 'thinking' },
    timestamp: Date.now(),
    model: activeModel.name,
  });

  let docPendingReasoning = '';
  let docReasoningFlushRaf = 0;
  const flushDocReasoningImmediately = (): void => {
    if (docReasoningFlushRaf !== 0) {
      window.cancelAnimationFrame(docReasoningFlushRaf);
      docReasoningFlushRaf = 0;
    }
    const merged = docPendingReasoning;
    docPendingReasoning = '';
    if (!merged) return;
    ui.appendReasoningToMessage(sendSessionId, assistantId, merged);
  };
  const queueDocReasoningChunk = (th: string): void => {
    docPendingReasoning += th;
    if (docReasoningFlushRaf !== 0) return;
    docReasoningFlushRaf = window.requestAnimationFrame(() => {
      docReasoningFlushRaf = 0;
      flushDocReasoningImmediately();
    });
  };

  const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
    onDelta: (d) => {
      artifactBuffer += d;
    },
    onThinkingDelta: (th) => {
      if (th) queueDocReasoningChunk(th);
    },
    onError: (m) => {
      flushDocReasoningImmediately();
      ui.streamHadErrorRef.current = true;
      ui.updateMessage(sendSessionId, assistantId, {
        content: ui.t('chat.requestFailed') + m,
        exportHint,
      });
    },
    locale: ui.locale,
    onEnd: () => {
      void (async () => {
        flushDocReasoningImmediately();
        ui.streamUnsubRef.current = null;
        const aborted = ui.streamCancelledByUserRef.current;
        ui.streamCancelledByUserRef.current = false;
        await withStreamLifecycle(
          assistantId,
          {
            onFinalize: () => {
              ui.setIsStreaming(false);
              ui.clearLoadingForSession(sendSessionId);
              ui.streamingAssistantIdRef.current = null;
              ui.streamingSessionIdRef.current = null;
              ui.setStreamingTargetAssistantId(null);
            },
          },
          async () => {
            if (ui.streamHadErrorRef.current) return;
            if (aborted) {
              ui.updateMessage(sendSessionId, assistantId, {
                content: ui.t('chat.stoppedBanner'),
                exportHint,
              });
              return;
            }
            const artifactBody = stripGenerateImageArtifactsForDisplay(artifactBuffer).trim();
            ui.updateMessage(sendSessionId, assistantId, {
              exportHint: { ...exportHint, status: 'generating' },
            });
            const artifactFiles = await createDocumentArtifactsFromMarkdown(
              artifactBody,
              documentExportFormatsFromHint(exportHint),
              documentArtifactBaseNameFromContent(
                artifactBody,
                documentArtifactBaseName(userMessage.content)
              )
            );
            ui.updateMessage(sendSessionId, assistantId, {
              content: artifactFiles.length
                ? ui.t('chat.documentReady')
                : ui.t('chat.documentWriteFailed'),
              exportHint,
              files: artifactFiles.length ? artifactFiles : undefined,
            });
          }
        );
      })();
    },
  });
  ui.streamUnsubRef.current = unsub;
}

function runSseStreamReply(args: RunStreamReplyPathArgs): void {
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

  ui.streamHadErrorRef.current = false;
  ui.streamCancelledByUserRef.current = false;
  const assistantId = `${Date.now()}-a`;
  ui.streamingAssistantIdRef.current = assistantId;
  ui.streamingSessionIdRef.current = sendSessionId;
  ui.setStreamingTargetAssistantId(assistantId);
  ui.setIsStreaming(true);
  ui.addMessage(sendSessionId, {
    id: assistantId,
    role: 'assistant',
    content: '',
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
    void reader.start();
  }

  const voiceReplyThisTurn = Boolean(ui.speechReaderRef.current);

  const imgBase = ui.inlineImageIndexRef.current;

  const contentStream = createAnimStream(sendSessionId, assistantId, ui.appendToMessage);
  const reasoningStream = createAnimStream(sendSessionId, assistantId, ui.appendReasoningToMessage);
  const flushPendingContentDeltaImmediately = contentStream.flush;
  const drainReasoningBufferUnsafe = reasoningStream.flush;
  const queueContentDeltaChunk = contentStream.push;
  const queueReasoningDeltaChunk = reasoningStream.push;

  const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
    onDelta: (d) => {
      queueContentDeltaChunk(d);
      if (voiceReplyThisTurn) {
        ui.speechReaderRef.current?.push(d);
      }
    },
    onThinkingDelta: (th) => {
      if (th) queueReasoningDeltaChunk(th);
    },
    onError: (m) => {
      flushPendingContentDeltaImmediately();
      drainReasoningBufferUnsafe();
      ui.speechReaderRef.current?.cancel();
      ui.setVoiceReplySpeaking(false);
      ui.streamHadErrorRef.current = true;
      const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
      const prior = sess?.messages.find((x) => x.id === assistantId)?.content?.trimEnd() ?? '';
      const injected = prior
        ? `${prior}\n\n---\n\n${ui.t('chat.streamInterrupted')}\n${m}`
        : `${ui.t('chat.streamInterrupted')}\n${m}`;
      ui.updateMessage(sendSessionId, assistantId, { content: injected });
    },
    locale: ui.locale,
    onEnd: () => {
      void (async () => {
        flushPendingContentDeltaImmediately();
        drainReasoningBufferUnsafe();
        ui.streamUnsubRef.current = null;
        const aborted = ui.streamCancelledByUserRef.current;
        ui.streamCancelledByUserRef.current = false;

        await withStreamLifecycle(
          assistantId,
          {
            onFinalize: () => {
              ui.setIsStreaming(false);
              ui.clearLoadingForSession(sendSessionId);
              ui.streamingAssistantIdRef.current = null;
              ui.streamingSessionIdRef.current = null;
              ui.setStreamingTargetAssistantId(null);
            },
          },
          async () => {
            if (ui.streamHadErrorRef.current) {
              ui.speechReaderRef.current?.cancel();
              ui.setVoiceReplySpeaking(false);
              return;
            }

            const msg = useChatStore.getState()
              .sessions.find((s) => s.id === sendSessionId)
              ?.messages.find((m) => m.id === assistantId);
            const raw = msg?.content ?? '';
            const reasoningText = (msg?.reasoning ?? '').trim();

            const plannedIntent = planImageIntent({
              userText: userMessage.content,
              historyBeforeUser,
              assistantText: raw,
              toolCallCount: extractGenerateImageCalls(raw).length,
            });

            if (aborted && !raw.trim() && !plannedIntent.shouldGenerate) {
              ui.speechReaderRef.current?.cancel();
              ui.setVoiceReplySpeaking(false);
              ui.removeMessage(sendSessionId, assistantId);
              return;
            }

            /** SSE 正文已全部写入；先于生图后处理解除流式态 */
            ui.setIsStreaming(false);
            ui.streamingAssistantIdRef.current = null;
            ui.streamingSessionIdRef.current = null;
            ui.setStreamingTargetAssistantId(null);
            ui.speechReaderRef.current?.finish();

            let nextContent = raw;
            let nextFiles = msg?.files as Message['files'] | undefined;
            if (raw.trim() || plannedIntent.shouldGenerate) {
              try {
                const imageHooks = makeImageGenHooks({
                  assistantId,
                  syncImgGenUi: (v) => syncImgGenUi(ui, sendSessionId, v),
                  imageGenCancelledRef: ui.imageGenCancelledRef,
                  onImage: (image) =>
                    appendGeneratedImageToAssistant(ui, sendSessionId, assistantId, image),
                });
                const { content, files } = await postProcessAssistantContent(
                  raw,
                  activeModel,
                  imgBase,
                  ui.setInlineImageIndex,
                  {
                    imageGenHooks: imageHooks,
                    referenceImages: imageReferencePathsFromFiles(userMessage.files),
                    userPromptContext: userMessage.content,
                    plannedIntent,
                    shouldCancel: () => ui.imageGenCancelledRef.current,
                  }
                );
                nextContent = content;
                nextFiles = mergeAssistantFiles(sendSessionId, assistantId, files);
              } catch (e) {
                nextContent =
                  raw + '\n\n' + ui.t('postProcess.tag') + (e instanceof Error ? e.message : String(e));
              }
              if (aborted) {
                nextContent = `${nextContent}\n\n---\n\n${ui.t('chat.stoppedBanner')}`;
              }
            }
            if (!nextContent.trim() && !nextFiles?.length && reasoningText) {
              nextContent = ui.t('chat.emptyAfterReasoning');
            }

            ui.updateMessage(sendSessionId, assistantId, {
              content: nextContent,
              files: mergeAssistantFiles(sendSessionId, assistantId, nextFiles as FileInfo[] | undefined),
              ...(exportHint ? { exportHint } : {}),
              imageGenProgress: undefined,
            });
          }
        );
      })();
    },
  });
  ui.streamUnsubRef.current = unsub;
}
