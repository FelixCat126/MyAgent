import type { Message, ModelConfig, FileInfo } from '../types';
import { useChatStore } from '../store/chatStore';
import { useSettingStore } from '../store/settingStore';
import { canUseSseStream } from '../utils/chatModelPolicy';
import {
  createAnimStream,
  beginAssistantStream,
  createVoiceWakeReplyReader,
  fulfillDocumentArtifact,
  mergeAssistantFiles,
  planAssistantImageIntent,
  resetStreamingUi,
  runImagePostProcess,
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

  let artifactBuffer = '';
  const assistantId = beginAssistantStream(ui, sendSessionId, {
    assistantId: `${Date.now()}-doc`,
    modelName: activeModel.name,
    exportHint: { ...exportHint, status: 'thinking' },
  });

  const reasoningStream = createAnimStream(sendSessionId, assistantId, ui.appendReasoningToMessage);

  const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
    onDelta: (d) => {
      artifactBuffer += d;
    },
    onThinkingDelta: (th) => {
      if (th) reasoningStream.push(th);
    },
    onError: (m) => {
      reasoningStream.flush();
      ui.streamHadErrorRef.current = true;
      ui.updateMessage(sendSessionId, assistantId, {
        content: ui.t('chat.requestFailed') + m,
        exportHint,
      });
    },
    locale: ui.locale,
    onEnd: () => {
      void (async () => {
        reasoningStream.flush();
        ui.streamUnsubRef.current = null;
        const aborted = ui.streamCancelledByUserRef.current;
        ui.streamCancelledByUserRef.current = false;
        await withStreamLifecycle(
          assistantId,
          {
            onFinalize: () => resetStreamingUi(ui, sendSessionId),
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
            ui.updateMessage(sendSessionId, assistantId, {
              exportHint: { ...exportHint, status: 'generating' },
            });
            await fulfillDocumentArtifact({
              ui,
              sendSessionId,
              assistantId,
              rawText: artifactBuffer,
              userText: userMessage.content,
              exportHint,
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

  const assistantId = beginAssistantStream(ui, sendSessionId, {
    assistantId: `${Date.now()}-a`,
    modelName: activeModel.name,
    ...(exportHint ? { exportHint } : {}),
  });

  const voiceReader = createVoiceWakeReplyReader(ui);
  if (voiceReader) void voiceReader.start();
  const voiceReplyThisTurn = Boolean(voiceReader);

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
            onFinalize: () => resetStreamingUi(ui, sendSessionId),
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

            const plannedIntent = planAssistantImageIntent(userMessage, historyBeforeUser, raw);

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
                const { content, files } = await runImagePostProcess({
                  ui,
                  sendSessionId,
                  assistantId,
                  rawText: raw,
                  userMessage,
                  activeModel,
                  historyBeforeUser,
                  plannedIntent,
                });
                nextContent = content;
                nextFiles = files;
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
