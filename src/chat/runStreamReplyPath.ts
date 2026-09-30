import { imageTaskWasCancelled, releaseImageTask, replyRunWasCancelled } from './imageTaskState';
import type { Message, ModelConfig, FileInfo } from '../types';
import { useChatStore } from '../store/chatStore';
import { useSettingStore } from '../store/settingStore';
import { canUseSseStream } from '../utils/chatModelPolicy';
import { inferReplyExportHint } from '../utils/documentExportIntent';
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
import { runVideoPostProcess } from './videoGenAssist';
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

  const reasoningStream = createAnimStream(
    sendSessionId,
    assistantId,
    ui.appendReasoningToMessage,
    { pace: 'reasoning' },
  );

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
        content: artifactBuffer || ui.t('chat.requestFailed') + m,
        exportHint: { ...exportHint, status: 'failed', error: m },
      });
    },
    locale: ui.locale,
    onEnd: () => {
      void (async () => {
        reasoningStream.flush();
        ui.streamUnsubRef.current = null;
        const aborted = replyRunWasCancelled(sendSessionId, userMessage.id) || ui.streamCancelledByUserRef.current;
        ui.streamCancelledByUserRef.current = false;
        await withStreamLifecycle(
          assistantId,
          {
            onFinalize: () => {
              if (!imageTaskWasCancelled(assistantId) && !replyRunWasCancelled(sendSessionId, userMessage.id)) resetStreamingUi(ui, sendSessionId);
              releaseImageTask(assistantId);
            },
          },
          async () => {
            if (ui.streamHadErrorRef.current) return;
            if (aborted) {
              ui.updateMessage(sendSessionId, assistantId, {
                content: artifactBuffer || ui.t('chat.stoppedBanner'),
                exportHint: { ...exportHint, status: 'failed', error: ui.t('chat.stoppedBanner') },
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
              shouldCancel: () => replyRunWasCancelled(sendSessionId, userMessage.id),
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

  /** 正文先缓冲；思考逐字排空后才恢复，避免两段内容在界面上交叉播放。 */
  const contentStream = createAnimStream(sendSessionId, assistantId, ui.appendToMessage, {
    startPaused: true,
  });
  const reasoningStream = createAnimStream(
    sendSessionId,
    assistantId,
    ui.appendReasoningToMessage,
    { pace: 'reasoning' },
  );
  const flushPendingContentDeltaImmediately = contentStream.flush;
  const drainReasoningBufferUnsafe = reasoningStream.flush;
  const finishContentAtComfortablePace = contentStream.finish;
  const finishReasoningAtComfortablePace = reasoningStream.finish;
  const queueContentDeltaChunk = contentStream.push;
  const queueReasoningDeltaChunk = reasoningStream.push;
  let contentStartPromise: Promise<void> | null = null;
  let contentHasStarted = false;
  let pendingVoiceContent = '';

  const startContentAfterReasoning = (): Promise<void> => {
    if (!contentStartPromise) {
      contentStartPromise = finishReasoningAtComfortablePace().then(() => {
        contentHasStarted = true;
        contentStream.resume();
        if (voiceReplyThisTurn && pendingVoiceContent) {
          ui.speechReaderRef.current?.push(pendingVoiceContent);
          pendingVoiceContent = '';
        }
      });
    }
    return contentStartPromise;
  };

  const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
    onDelta: (d) => {
      queueContentDeltaChunk(d);
      if (voiceReplyThisTurn) {
        if (contentHasStarted) ui.speechReaderRef.current?.push(d);
        else pendingVoiceContent += d;
      }
      void startContentAfterReasoning();
    },
    onThinkingDelta: (th) => {
      if (th) queueReasoningDeltaChunk(th);
    },
    onError: (m) => {
      drainReasoningBufferUnsafe();
      flushPendingContentDeltaImmediately();
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
        const aborted = replyRunWasCancelled(sendSessionId, userMessage.id) || ui.streamCancelledByUserRef.current;
        if (aborted || ui.streamHadErrorRef.current) {
          drainReasoningBufferUnsafe();
          flushPendingContentDeltaImmediately();
        } else {
          await startContentAfterReasoning();
          await finishContentAtComfortablePace();
        }
        ui.streamUnsubRef.current = null;
        ui.streamCancelledByUserRef.current = false;

        await withStreamLifecycle(
          assistantId,
          {
            onFinalize: () => {
              if (!imageTaskWasCancelled(assistantId) && !replyRunWasCancelled(sendSessionId, userMessage.id)) resetStreamingUi(ui, sendSessionId);
              releaseImageTask(assistantId);
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
            if (!aborted && (raw.trim() || plannedIntent.shouldGenerate)) {
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
            if (aborted) nextContent = `${nextContent}\n\n${ui.t('chat.stoppedBanner')}`;
            /** 视频生成：客户端代理 + 后台模式。
             *  视频生成耗时 30s~几分钟，绝不阻塞消息收尾——消息先正常显示，
             *  视频在后台生成，完成后由 videoGenAssist 直接 updateMessage 追加附件。 */
            void runVideoPostProcess({
              ui,
              sendSessionId,
              assistantId,
              rawText: nextContent,
              userMessage,
              activeModel,
              historyBeforeUser,
              currentMsg: msg,
            }).catch((e) => {
              console.warn('[videoGenAssist] 后台视频生成失败', e);
            });
            if (!nextContent.trim() && !nextFiles?.length && reasoningText) {
              nextContent = ui.t('chat.emptyAfterReasoning');
            }

            /** 内容驱动导出：用户没明说"下载"时，按回复内容反推格式（文档→docx/pdf，表格→xlsx） */
            const replyHint = inferReplyExportHint(nextContent, userMessage.content);
            const effectiveExportHint =
              exportHint ?? (replyHint ? { ...replyHint } : undefined);

            ui.updateMessage(sendSessionId, assistantId, {
              content: nextContent,
              files: mergeAssistantFiles(sendSessionId, assistantId, nextFiles as FileInfo[] | undefined),
              ...(effectiveExportHint ? { exportHint: effectiveExportHint } : {}),
              imageGenProgress: undefined,
            });
          }
        );
      })();
    },
  });
  ui.streamUnsubRef.current = unsub;
}
