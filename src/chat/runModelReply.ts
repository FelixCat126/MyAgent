import type React from 'react';
import type { Message, FileInfo, ModelConfig } from '../types';
import type { Locale } from '../i18n/types';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { StreamingSpeechReader } from '../utils/streamingSpeech';
import { canUseSseStream, effectiveWebEnabled } from '../utils/chatModelPolicy';
import { enrichMessagesForModel } from '../utils/enrichMessagesForModel';
import { sanitizeMessagesForModel } from '../utils/sanitizeMessagesForModel';
import { isAgentToolsBuildEnabled } from '@/agent/buildFlags';
import { runAgentLoop } from '@/agent/agentRunner';
import { looksLikeLocalFileAgentRequest, looksLikeLocalImageFindRequest } from '@/agent/localFileIntent';
import { looksLikeWebBrowseRequest } from '@/agent/webBrowseIntent';
import { extractGenerateImageCalls, stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';
import { planImageIntent } from '../utils/imageIntentPlanner';
import {
  documentArtifactBaseName,
  documentArtifactBaseNameFromContent,
  documentExportFormatsFromHint,
  inferDocumentExportHint,
} from '../utils/documentExportIntent';
import {
  buildOutgoingChain,
  formatVectorRagHint,
  prependImageGenCapabilitySystem,
  type VectorRagSendHint,
} from './outgoingChain';
import {
  type ImageGenProgressHooks,
  postProcessAssistantContent,
  imageReferencePathsFromFiles,
  createDocumentArtifactsFromMarkdown,
} from './imageGenAssist';

export type RunModelReplyUi = {
  locale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
  consumeVoiceWakeReply: () => boolean;
  setVoiceReplySpeaking: (v: boolean) => void;
  setVectorRagStatus: (v: { text: string; tone: 'success' | 'info' | 'error' } | null) => void;
  setImageGenProgress: (v: { current: number; total: number; messageId: string } | null) => void;
  setIsStreaming: (v: boolean) => void;
  setStreamingTargetAssistantId: (id: string | null) => void;
  setInlineImageIndex: React.Dispatch<React.SetStateAction<number>>;
  inlineImageIndexRef: React.MutableRefObject<number>;
  streamingAssistantIdRef: React.MutableRefObject<string | null>;
  streamingSessionIdRef: React.MutableRefObject<string | null>;
  streamUnsubRef: React.MutableRefObject<(() => void) | null>;
  streamHadErrorRef: React.MutableRefObject<boolean>;
  streamCancelledByUserRef: React.MutableRefObject<boolean>;
  imageGenCancelledRef: React.MutableRefObject<boolean>;
  imageGenSyncRef: React.MutableRefObject<{ sessionId: string; messageId: string } | null>;
  speechReaderRef: React.MutableRefObject<StreamingSpeechReader | null>;
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, patch: Partial<Message>) => void;
  appendToMessage: (sessionId: string, messageId: string, chunk: string) => void;
  appendReasoningToMessage: (sessionId: string, messageId: string, chunk: string) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  clearLoadingForSession: (sessionId: string) => void;
};

export async function runModelReply(
  ui: RunModelReplyUi,
  sendSessionId: string,
  historyBeforeUser: Message[],
  userMessage: Message,
  activeModel: ModelConfig
): Promise<void> {
  const session = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
  const webState = useWebSearchStore.getState();
  const webOn = effectiveWebEnabled(session, webState.enabled);
  ui.setVectorRagStatus(null);

  const syncImgGenUi = (v: { current: number; total: number; messageId: string } | null): void => {
    if (v) {
      ui.imageGenSyncRef.current = { sessionId: sendSessionId, messageId: v.messageId };
      ui.setImageGenProgress(v);
      ui.updateMessage(sendSessionId, v.messageId, {
        imageGenProgress: { current: v.current, total: v.total },
      });
      return;
    }
    ui.setImageGenProgress(null);
    const p = ui.imageGenSyncRef.current;
    if (p && p.sessionId === sendSessionId) {
      ui.updateMessage(p.sessionId, p.messageId, { imageGenProgress: undefined });
      ui.imageGenSyncRef.current = null;
    }
  };

  let chain: Message[];
  let ragHint: VectorRagSendHint;
  const exportHint = inferDocumentExportHint(userMessage.content);
  const isLocalImageFind = looksLikeLocalImageFindRequest(userMessage.content);
  const isWebBrowseTask = looksLikeWebBrowseRequest(userMessage.content);
  const willRunLocalAgent =
    isAgentToolsBuildEnabled() &&
    !exportHint?.document &&
    useSettingStore.getState().agentLocalToolsEnabled &&
    looksLikeLocalFileAgentRequest(userMessage.content);
  const willRunWebAgent =
    isAgentToolsBuildEnabled() &&
    !exportHint?.document &&
    useSettingStore.getState().agentBrowserEnabled &&
    isWebBrowseTask;
  /** 本机/网页 Agent 任务均跳过向量注入，避免无关 RAG 干扰工具链 */
  const skipContextInject = willRunLocalAgent || willRunWebAgent;
  try {
    const built = await buildOutgoingChain(
      historyBeforeUser,
      userMessage,
      {
        enabled: webOn,
        provider: webState.provider,
        apiKey: webState.apiKey,
      },
      { skipContextInject }
    );
    chain = isLocalImageFind || isWebBrowseTask
      ? built.chain
      : prependImageGenCapabilitySystem(built.chain, ui.locale, useModelStore.getState().getEffectiveImageGenModel());
    ragHint = built.ragHint;
  } catch (e) {
    console.error(e);
    ui.addMessage(sendSessionId, {
      id: `${Date.now()}-err`,
      role: 'assistant',
      content: ui.t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
  timestamp: Date.now(),
  model: activeModel.name,
    });
    ui.clearLoadingForSession(sendSessionId);
    return;
  }

  let chainForModel: Message[];
  try {
    chainForModel = await enrichMessagesForModel(chain, ui.locale);
    if (exportHint?.document) {
      chainForModel = [
        {
          id: `doc-export-sys-${Date.now()}`,
          role: 'system',
          content:
            '用户本轮明确要求可下载文档。请直接输出可作为文档保存的正文内容，使用 Markdown 标题/章节组织；不要添加“我已经为你准备好”“点击下载”“以下是文档”等聊天式前后缀，也不要把无关说明放入正文。',
          timestamp: Date.now(),
          model: 'myagent-document-export',
        },
        ...chainForModel,
      ];
    }
  } catch (e) {
    console.error(e);
    ui.addMessage(sendSessionId, {
      id: `${Date.now()}-err2`,
      role: 'assistant',
      content: ui.t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
      timestamp: Date.now(),
      model: activeModel.name,
    });
    ui.clearLoadingForSession(sendSessionId);
    return;
  }

  ui.setVectorRagStatus(formatVectorRagHint(ragHint, ui.t));

  const plainMessages = JSON.parse(JSON.stringify(sanitizeMessagesForModel(chainForModel))) as Message[];
  const plainModel = JSON.parse(JSON.stringify(activeModel)) as ModelConfig;
  const preplannedImageIntent = planImageIntent({
    userText: userMessage.content,
    historyBeforeUser,
    assistantText: '',
    toolCallCount: 0,
  });
  const imageToolExpected =
    preplannedImageIntent.shouldGenerate &&
    !!useModelStore.getState().getEffectiveImageGenModel();
  if (imageToolExpected) {
    plainModel.maxTokens = Math.min(plainModel.maxTokens || 1024, 1024);
  }
  const appendGeneratedImageToAssistant = (
    assistantId: string,
    image: { url: string; path: string; width: number; height: number }
  ): void => {
    const name = image.path.split(/[\\/]/).pop() || 'generated-image.png';
    const file: FileInfo = {
      name,
      path: image.path,
      type: 'image/png',
      size: 0,
      preview: image.url,
    };
    const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
    const msg = sess?.messages.find((m) => m.id === assistantId);
    const prev = (msg?.files ?? []) as FileInfo[];
    if (prev.some((f) => f.path === file.path)) return;
    ui.updateMessage(sendSessionId, assistantId, { files: [...prev, file] });
  };
  const mergeAssistantFiles = (assistantId: string, incoming?: FileInfo[]): FileInfo[] | undefined => {
    const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
    const msg = sess?.messages.find((m) => m.id === assistantId);
    const merged: FileInfo[] = [...((msg?.files ?? []) as FileInfo[])];
    for (const f of incoming ?? []) {
      if (!merged.some((x) => x.path === f.path)) merged.push(f);
    }
    return merged.length ? merged : undefined;
  };

  if (
    isAgentToolsBuildEnabled() &&
    !exportHint?.document &&
    (useSettingStore.getState().agentLocalToolsEnabled ||
      (useSettingStore.getState().agentBrowserEnabled &&
        looksLikeWebBrowseRequest(userMessage.content)))
  ) {
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
        const imageHooks: ImageGenProgressHooks = {
          onBegin: ({ total }) => {
            ui.imageGenCancelledRef.current = false;
            syncImgGenUi({ current: 1, total, messageId: assistantId });
          },
          onEachStart: ({ current, total }) => syncImgGenUi({ current, total, messageId: assistantId }),
          onEachDone: ({ done, total }) =>
            syncImgGenUi(
              done >= total
                ? { current: total, total, messageId: assistantId }
                : { current: done + 1, total, messageId: assistantId }
            ),
          onImage: ({ image }) => appendGeneratedImageToAssistant(assistantId, image),
          onDone: () => syncImgGenUi(null),
        };
        const plannedIntent = planImageIntent({
          userText: userMessage.content,
          historyBeforeUser,
          assistantText: agentOut.displayText,
          toolCallCount: extractGenerateImageCalls(agentOut.displayText).length,
        });
        if (isLocalImageFind || isWebBrowseTask) {
          ui.updateMessage(sendSessionId, assistantId, {
            content: agentOut.displayText ?? '',
            files: mergeAssistantFiles(assistantId, agentOut.exportFiles),
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
          files: mergeAssistantFiles(assistantId, [
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
        return;
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
      return;
    } finally {
      ui.setIsStreaming(false);
      ui.streamingAssistantIdRef.current = null;
      ui.streamingSessionIdRef.current = null;
      ui.setStreamingTargetAssistantId(null);
      ui.streamCancelledByUserRef.current = false;
    }
  }

  if (exportHint?.document && canUseSseStream(activeModel)) {
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
          try {
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
                ? '文档已生成，点击下方文件即可查看或另存。'
                : '文档内容已生成，但写入本地文件失败。请重试或检查文档目录权限。',
              exportHint,
              files: artifactFiles.length ? artifactFiles : undefined,
            });
          } finally {
            ui.setIsStreaming(false);
            ui.clearLoadingForSession(sendSessionId);
            ui.streamingAssistantIdRef.current = null;
            ui.streamingSessionIdRef.current = null;
            ui.setStreamingTargetAssistantId(null);
          }
        })();
      },
    });
    ui.streamUnsubRef.current = unsub;
    return;
  }

  const useStream =
    !exportHint?.document &&
    useSettingStore.getState().streamResponses &&
    canUseSseStream(activeModel);

  if (useStream) {
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
    /**
     * 逐字符动画流式渲染器（content 和 reasoning 共用）。
     *
     * 用固定间隔定时器（TICK_MS=25ms ≈ 40fps 写入）替代 rAF，
     * 每次tick取少量字符追加到 store。固定间隔保证帧间衔接均匀无"瘸"感。
     *
     * 速度档位（在上一版基础上再降 ~10%）：
     * - buffer ≤14 字 → 每次 1 字（最丝滑）
     * - ≤38 字 → 每次 2 字
     * - ≤90 字 → 每次 len/12
     * - >90 字 → 每次 len/6（积压严重时加速追赶）
     */
    const TICK_MS = 25;
    const createAnimStream = (
      appendFn: (sessionId: string, msgId: string, chunk: string) => void
    ) => {
      let buffer = '';
      let timerId: ReturnType<typeof setInterval> | null = null;
      const flush = () => {
        if (timerId !== null) {
          clearInterval(timerId);
          timerId = null;
        }
        if (!buffer) return;
        appendFn(sendSessionId, assistantId, buffer);
        buffer = '';
      };
      const tick = () => {
        if (!buffer) {
          if (timerId !== null) {
            clearInterval(timerId);
            timerId = null;
          }
          return;
        }
        const len = buffer.length;
        let take: number;
        if (len <= 14) take = 1;
        else if (len <= 38) take = 2;
        else if (len <= 90) take = Math.ceil(len / 12);
        else take = Math.ceil(len / 6);
        const chunk = buffer.slice(0, take);
        buffer = buffer.slice(take);
        appendFn(sendSessionId, assistantId, chunk);
      };
      return {
        push(d: string) {
          if (!d) return;
          buffer += d;
          if (timerId === null) {
            timerId = setInterval(tick, TICK_MS);
          }
        },
        flush,
      };
    };

    const contentStream = createAnimStream(ui.appendToMessage);
    const reasoningStream = createAnimStream(ui.appendReasoningToMessage);
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

          try {
            if (ui.streamHadErrorRef.current) {
              ui.speechReaderRef.current?.cancel();
              ui.setVoiceReplySpeaking(false);
              ui.setIsStreaming(false);
              ui.clearLoadingForSession(sendSessionId);
              ui.streamingAssistantIdRef.current = null;
              ui.streamingSessionIdRef.current = null;
              ui.setStreamingTargetAssistantId(null);
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
              ui.setIsStreaming(false);
              ui.clearLoadingForSession(sendSessionId);
              ui.streamingAssistantIdRef.current = null;
              ui.streamingSessionIdRef.current = null;
              ui.setStreamingTargetAssistantId(null);
              return;
            }

            /** SSE 正文已全部写入本地消息；先于生图后处理解除「流式」态，使 strip 与生图占位顺序符合「先说清再画图」 */
            ui.setIsStreaming(false);
            ui.streamingAssistantIdRef.current = null;
            ui.streamingSessionIdRef.current = null;
            ui.setStreamingTargetAssistantId(null);
            ui.speechReaderRef.current?.finish();

            let nextContent = raw;
            let nextFiles = msg?.files as Message['files'] | undefined;
            if (raw.trim() || plannedIntent.shouldGenerate) {
              try {
                const imageHooks: ImageGenProgressHooks = {
                  onBegin: ({ total }) => {
                    ui.imageGenCancelledRef.current = false;
                    syncImgGenUi({ current: 1, total, messageId: assistantId });
                  },
                  onEachStart: ({ current, total }) =>
                    syncImgGenUi({ current, total, messageId: assistantId }),
                  onEachDone: ({ done, total }) =>
                    syncImgGenUi(
                      done >= total
                        ? { current: total, total, messageId: assistantId }
                        : { current: done + 1, total, messageId: assistantId }
                    ),
                  onImage: ({ image }) => appendGeneratedImageToAssistant(assistantId, image),
                  onDone: () => syncImgGenUi(null),
                };
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
                nextFiles = mergeAssistantFiles(assistantId, files);
              } catch (e) {
                nextContent =
                  raw + '\n\n' + ui.t('postProcess.tag') + (e instanceof Error ? e.message : String(e));
              }
              if (aborted) {
                nextContent =
                  `${nextContent}\n\n---\n\n${ui.t('chat.stoppedBanner')}`;
              }
            }
            if (!nextContent.trim() && !nextFiles?.length && reasoningText) {
              nextContent = ui.t('chat.emptyAfterReasoning');
            }

            ui.updateMessage(sendSessionId, assistantId, {
              content: nextContent,
              files: mergeAssistantFiles(assistantId, nextFiles as FileInfo[] | undefined),
              ...(exportHint ? { exportHint } : {}),
              imageGenProgress: undefined,
            });
          } finally {
            ui.setIsStreaming(false);
            ui.clearLoadingForSession(sendSessionId);
            ui.streamingAssistantIdRef.current = null;
            ui.streamingSessionIdRef.current = null;
            ui.setStreamingTargetAssistantId(null);
          }
        })();
      },
    });
    ui.streamUnsubRef.current = unsub;
    return;
  }

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
          ? '文档已生成，点击下方文件即可查看或另存。'
          : '文档内容已生成，但写入本地文件失败。请重试或检查文档目录权限。',
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
    const imageHooks: ImageGenProgressHooks = {
      onBegin: ({ total }) => {
        ui.imageGenCancelledRef.current = false;
        syncImgGenUi({ current: 1, total, messageId: assistantId });
      },
      onEachStart: ({ current, total }) => syncImgGenUi({ current, total, messageId: assistantId }),
      onEachDone: ({ done, total }) =>
        syncImgGenUi(
          done >= total
            ? { current: total, total, messageId: assistantId }
            : { current: done + 1, total, messageId: assistantId }
        ),
      onImage: ({ image }) => appendGeneratedImageToAssistant(assistantId, image),
      onDone: () => syncImgGenUi(null),
    };
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
      files: mergeAssistantFiles(assistantId, files),
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
