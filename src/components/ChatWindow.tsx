import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { useParticleStore } from '../store/particleStore';
import { useI18n } from '../hooks/useI18n';
import { showError, showWarning } from '../store/errorStore';
import { confirmDestructive } from '../store/confirmStore';
import { ChatSession, FileInfo, Message } from '../types';
import { useWebSpeechDictation, type SpeechApiTranscribeConfig } from '@/hooks/useWebSpeechDictation';
import { useVoiceWake } from '@/hooks/useVoiceWake';
import { useMainWindowFocused } from '@/hooks/useMainWindowFocused';
import { useSystemTtsAvailable } from '@/hooks/useSystemTtsAvailable';
import { speakText } from '@/utils/speakText';
import { StreamingSpeechReader } from '@/utils/streamingSpeech';
import { sessionToHtml, sessionToMarkdown } from '../utils/exportChat';
import { effectiveWebEnabled } from '../utils/chatModelPolicy';
import {
  agentBrowserClose,
  agentBrowserEval,
  agentBrowserOpen,
  agentBrowserRead,
} from '@/agent/browser/agentBrowserController';
import {
  estimateSessionChars,
  resolveContextProgressFullChars,
} from '../utils/contextBudget';
import { resolveContextSoftLimitChars } from '../utils/inferContextWindow';
import {
  estimateInjectedPayloadOverheadChars,
  messagesExceedSanitizeLimit,
} from '../chat/payloadBoundary';
import {
  commitUserMessageAndReply,
  resolveInjectExtras,
  tryClaimSessionSend,
} from '../chat/sendPipeline';
import { resubmitEditedUserMessage } from '../chat/resubmitEditedUserMessage';
import { installRemoteChatBridge } from '../chat/remoteBridge';

import { ChatToolbar } from './ChatWindow/ChatToolbar';
import { MessageStream } from './ChatWindow/MessageStream';
import { ChatComposer } from './ChatWindow/ChatComposer';
import { GalleryModal } from './ChatWindow/GalleryModal';
import { useChatScrollStick } from './ChatWindow/hooks/useChatScrollStick';
import { useMessageSelection } from './ChatWindow/hooks/useMessageSelection';
import { useChatAttachments } from './ChatWindow/hooks/useChatAttachments';
import { useChatLifecycleCleanup } from './ChatWindow/hooks/useChatLifecycle';
import { useChatStreamRefs } from './ChatWindow/hooks/useChatStreamRefs';
import { useChatRunModelReply } from './ChatWindow/hooks/useChatRunModelReply';
import {
  buildConversationImageGallery,
  findConversationGalleryIndex,
  type ConversationImageGalleryItem,
} from '../utils/conversationImageGallery';
import { FOOTER_H_PX } from '../constants/layout';

const ChatWindow: React.FC<{ footerH?: number }> = ({ footerH = FOOTER_H_PX }) => {
  const {
    currentSessionId,
    sessions,
    removeMessages,
    updateMessage,
    loadingSessionIds,
    clearLoadingForSession,
    setSessionWebOverride,
    compressingSessionIds,
  } = useChatStore();

  const webSearchEnabled = useWebSearchStore((s) => s.enabled);
  const speechInputEnabled = useSettingStore((s) => s.speechInputEnabled);
  const voiceWakeEnabled = useSettingStore((s) => s.voiceWakeEnabled);
  const voiceWakePhrase = useSettingStore((s) => s.voiceWakePhrase);
  const { t, locale: uiLocale } = useI18n();
  const systemTtsAvailable = useSystemTtsAvailable(uiLocale);
  const ttsPlaybackReady = systemTtsAvailable === true;

  const isCurrentSessionLoading = loadingSessionIds.has(currentSessionId ?? '');
  const isCompressingCurrent =
    !!currentSessionId && compressingSessionIds.has(currentSessionId);
  const isSessionBusy = isCurrentSessionLoading || isCompressingCurrent;
  const { getActiveModel } = useModelStore();

  // ===== 局部 state（保持原顺序） =====
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [vectorRagStatus, setVectorRagStatus] = useState<{
    text: string;
    tone: 'success' | 'info' | 'error';
  } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  /** 本地/HTTP 生图进行中：对话区占位，避免长耗时无反馈 */
  const [imageGenProgress, setImageGenProgress] = useState<{
    current: number;
    total: number;
    messageId: string;
  } | null>(null);
  const [streamingTargetAssistantId, setStreamingTargetAssistantId] = useState<string | null>(null);
  const [inlineImageIndex, setInlineImageIndex] = useState(0);
  const inlineImageIndexRef = useRef(0);
  inlineImageIndexRef.current = inlineImageIndex;
  const [voiceReplySpeaking, setVoiceReplySpeaking] = useState(false);
  /** 唤醒态：唤醒词命中到发送/超时之间；驱动粒子呼吸 */
  const [voiceAwake, setVoiceAwake] = useState(false);
  const [conversationGalleryIdx, setConversationGalleryIdx] = useState<number | null>(null);
  const [conversationGalleryNonce, setConversationGalleryNonce] = useState(0);

  // ===== refs =====
  const inputAreaRef = useRef<HTMLTextAreaElement>(null);
  /** 流式 ref 集群：抽到 useChatStreamRefs（762→<600 减少行数集中） */
  const {
    streamUnsubRef,
    streamHadErrorRef,
    imageGenCancelledRef,
    streamCancelledByUserRef,
    streamingAssistantIdRef,
    streamingSessionIdRef,
    imageGenSyncRef,
  } = useChatStreamRefs();
  /** 中文/日文等 IME 组字中为 true，避免 Enter 上屏时被当成发送 */
  const imeComposingRef = useRef(false);
  /** 语音识别：与 input 同步，避免 onresult 闭包陈旧 */
  const inputSyncRef = useRef('');
  inputSyncRef.current = input;
  const handleSendRef = useRef<() => void>(() => {});
  const sendFromVoiceWakeRef = useRef(false);
  const speechReaderRef = useRef<StreamingSpeechReader | null>(null);
  /** 本轮回复是否来自语音唤醒闭环（唤醒听写自动发送） */
  const voiceWakeLoopRef = useRef(false);

  // ===== 业务派生 =====
  const currentSession = sessions.find((s: ChatSession) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];
  const conversationGallery: ConversationImageGalleryItem[] = useMemo(
    () => buildConversationImageGallery(messages),
    [messages]
  );

  // ===== 业务逻辑 =====
  const cancelVoiceReply = useCallback(() => {
    speechReaderRef.current?.cancel();
    speechReaderRef.current = null;
    setVoiceReplySpeaking(false);
  }, []);

  const consumeVoiceWakeReply = useCallback((): boolean => {
    if (!ttsPlaybackReady) return false;
    if (!useSettingStore.getState().voiceReplyEnabled) return false;
    if (!voiceWakeLoopRef.current) return false;
    voiceWakeLoopRef.current = false;
    return true;
  }, [ttsPlaybackReady]);

  const onDictationEnded = useCallback(({ autoSend, transcript }: { autoSend: boolean; transcript: string }) => {
    if (!autoSend || !transcript) return;
    voiceWakeLoopRef.current = true;
    sendFromVoiceWakeRef.current = true;
    setInput(transcript);
    window.setTimeout(() => {
      handleSendRef.current();
    }, 50);
  }, []);

  const speechLabels = useMemo(
    () => ({
      notSupported: t('chat.speechNotSupported'),
      needMic: t('chat.speechNeedMic'),
      startFailed: t('chat.speechStartFailed'),
      networkOrService: t('chat.speechNetwork'),
      noSpeech: t('chat.speechNoSpeech'),
      genericError: t('chat.speechGenericError'),
      transcribeFailed: t('chat.speechTranscribeFailed'),
      transcribeDenied: t('chat.speechMicDenied'),
    }),
    [t]
  );

  const getApiTranscribeConfig = useCallback((): SpeechApiTranscribeConfig | null => {
    const m = useModelStore.getState().getActiveModel();
    if (!m) return null;
    const key = (m.apiKey ?? '').trim();
    if (!key) return null;
    if (m.provider !== 'openai' && m.provider !== 'custom') return null;
    return { apiUrl: m.apiUrl, apiKey: key, provider: m.provider };
  }, []);

  /** 火山 ASR 配置读取（听写与唤醒共用，曾逐字重复两份） */
  const getVolcAsrConfig = useCallback(() => {
    const s = useSettingStore.getState();
    if (!s.speechInputEnabled) return null;
    return {
      appKey: s.volcAsrAppKey,
      accessKey: s.volcAsrAccessKey,
      resourceId: s.volcAsrResourceId,
    };
  }, []);

  const speechDictation = useWebSpeechDictation({
    inputValueRef: inputSyncRef,
    textareaRef: inputAreaRef,
    setInput,
    uiLocale,
    disabled: isSessionBusy || !speechInputEnabled,
    isImeComposing: () => imeComposingRef.current,
    labels: speechLabels,
    getVolcAsrConfig,
    getApiTranscribeConfig,
    onDictationEnded,
  });

  const windowFocused = useMainWindowFocused();

  const voiceWake = useVoiceWake({
    enabled: speechInputEnabled && voiceWakeEnabled,
    phrase: voiceWakePhrase,
    uiLocale,
    paused:
      isSessionBusy ||
      speechDictation.listening ||
      speechDictation.starting ||
      voiceReplySpeaking ||
      !windowFocused,
    getVolcAsrConfig,
    onWake: () => {
      setVoiceAwake(true);
      /** TTS 期间仅预拉麦克风；火山 WebSocket 在 TTS 结束后立即建连并推流 */
      const micPrep = speechDictation.prepareWakeMic();
      void (async () => {
        await Promise.all([
          micPrep,
          ttsPlaybackReady
            ? speakText(t('chat.voiceWakeAck'), uiLocale, { tailSilenceMs: 0 })
            : Promise.resolve(),
        ]);
        speechDictation.start({ fromWake: true });
      })();
    },
  });

  // ===== Hooks（5 个抽出的 hook） =====
  const selection = useMessageSelection();
  const attachments = useChatAttachments();
  const { scrollContainerRef, stickToBottomRef } = useChatScrollStick({
    currentSessionId: currentSessionId ?? null,
    showTypingDots: false, // 占位：useChatScrollStick 不会因为 showTypingDots 变化触发贴底以外的副作用，调用方在末尾 useLayoutEffect 中处理
    vectorRagStatus,
    footerH,
    attachmentsLength: attachments.attachments.length,
    isCompressingCurrent,
    imageGenProgress,
    messages,
  });
  useChatLifecycleCleanup({ cancelVoiceReply, streamUnsubRef });
  const { runModelReply, runModelReplyRef } = useChatRunModelReply({
    uiLocale,
    t,
    consumeVoiceWakeReply,
    setVoiceReplySpeaking,
    setVectorRagStatus,
    setImageGenProgress,
    setIsStreaming,
    setStreamingTargetAssistantId,
    setInlineImageIndex,
    inlineImageIndexRef,
    streamingAssistantIdRef,
    streamingSessionIdRef,
    streamUnsubRef,
    streamHadErrorRef,
    streamCancelledByUserRef,
    imageGenCancelledRef,
    imageGenSyncRef,
    speechReaderRef,
  });

  // ===== 业务 effect（不抽到 hook 的部分） =====
  /** 流式开始即清掉唤醒态；同时唤醒态自动 30 秒超时 */
  useEffect(() => {
    if (isStreaming && voiceAwake) setVoiceAwake(false);
  }, [isStreaming, voiceAwake]);
  useEffect(() => {
    if (!voiceAwake) return;
    const t2 = window.setTimeout(() => setVoiceAwake(false), 30000);
    return () => window.clearTimeout(t2);
  }, [voiceAwake]);

  /**
   * 业务态 → ParticleStore.agentActivity 派生。
   */
  useEffect(() => {
    const setAct = useParticleStore.getState().setAgentActivity;
    const streamOwnsCurrent =
      isStreaming &&
      streamingSessionIdRef.current != null &&
      streamingSessionIdRef.current === currentSessionId;
    if (streamOwnsCurrent) {
      const sess = sessions.find((s) => s.id === currentSessionId);
      const msg = sess?.messages.find((m) => m.id === streamingTargetAssistantId);
      const contentLen = (msg?.content ?? '').trim().length;
      setAct(contentLen > 0 ? 'replying' : 'thinking');
    } else if (voiceAwake) {
      setAct('awake');
    } else {
      setAct('idle');
    }
  }, [isStreaming, voiceAwake, sessions, currentSessionId, streamingTargetAssistantId]);

  useEffect(() => {
    const bridge = {
      open: (url: string) => agentBrowserOpen(url),
      read: (arg?: { maxChars?: number; selector?: string } | null) =>
        agentBrowserRead(arg ?? undefined),
      eval: (arg?: { js?: string } | null) => agentBrowserEval({ js: arg?.js ?? '' }),
      close: () => agentBrowserClose(),
    };
    (window as Window & { __MYAGENT_AGENT_BROWSER__?: typeof bridge }).__MYAGENT_AGENT_BROWSER__ =
      bridge;
    return () => {
      delete (window as Window & { __MYAGENT_AGENT_BROWSER__?: typeof bridge })
        .__MYAGENT_AGENT_BROWSER__;
    };
  }, []);

  useEffect(() => {
    return () => {
      useParticleStore.getState().setAgentActivity('idle');
    };
  }, []);

  useEffect(() => {
    if (!speechInputEnabled) speechDictation.abort();
  }, [speechInputEnabled, speechDictation.abort]);

  useEffect(() => {
    if (systemTtsAvailable !== false) return;
    const s = useSettingStore.getState();
    if (s.voiceReplyEnabled) s.setVoiceReplyEnabled(false);
  }, [systemTtsAvailable]);

  useEffect(() => {
    setConversationGalleryIdx(null);
    setConversationGalleryNonce(0);
    setVectorRagStatus(null);
    speechDictation.abort();
    cancelVoiceReply();
    voiceWakeLoopRef.current = false;
  }, [currentSessionId, speechDictation.abort, cancelVoiceReply]);

  useEffect(() => {
    if (!vectorRagStatus || vectorRagStatus.tone !== 'error') return;
    const tid = window.setTimeout(() => setVectorRagStatus(null), 6500);
    return () => window.clearTimeout(tid);
  }, [vectorRagStatus]);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electron : undefined;
    if (!api?.onMessage) return;
    const off = api.onMessage('myagent-clipboard-paste', (clip: unknown) => {
      const c = String(clip ?? '');
      if (!c) return;
      setInput((prev) => (prev ? `${prev}\n${c}` : c));
    });
    return off;
  }, []);

  useEffect(() => {
    return installRemoteChatBridge({
      runModelReply: (...a) => runModelReplyRef.current(...a),
    });
  }, []);

  // ===== 编辑 / 选择 / 导出 / 拖拽 / 输入 / 发送 / 停止 =====
  const handleStop = () => {
    streamCancelledByUserRef.current = true;
    imageGenCancelledRef.current = true;
    setImageGenProgress(null);
    const p = imageGenSyncRef.current;
    if (p) {
      updateMessage(p.sessionId, p.messageId, { imageGenProgress: undefined });
      imageGenSyncRef.current = null;
    }
    window.electron.closeModelStream();
    streamUnsubRef.current?.();
    streamUnsubRef.current = null;
    setIsStreaming(false);
    streamingSessionIdRef.current = null;
    const sid = currentSessionId;
    if (sid) clearLoadingForSession(sid);
    /** streamingAssistantIdRef 由 onEnd 清理，便于识别待删空气泡 */
  };

  const handleEditMessage = (message: Message) => {
    if (isSessionBusy) return;
    setEditingMessageId(message.id);
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
  };

  const handleDeleteSelected = () => {
    selection.deleteSelectedMessages({
      currentSessionId: currentSessionId ?? null,
      editingMessageId,
      setEditingMessageId,
      confirm: (msg) => confirmDestructive(msg),
      removeMessages,
      label: t('chat.confirmDeleteMessages', { count: selection.selectedMessageIds.size }),
    });
  };

  const handleExport = async (kind: 'md' | 'html') => {
    if (!currentSession) return;
    const content = kind === 'md' ? sessionToMarkdown(currentSession) : sessionToHtml(currentSession);
    const ext = kind === 'md' ? 'md' : 'html';
    const safe = (currentSession.title || 'export').replace(/[\\/:"*?<>|]/g, '_');
    await window.electron.saveTextFile({
      defaultName: `${safe}.${ext}`,
      content,
      filters:
        kind === 'md'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
  };

  const handleSend = async () => {
    if ((!input.trim() && attachments.attachments.length === 0) || !currentSessionId) return;

    cancelVoiceReply();
    if (!sendFromVoiceWakeRef.current) {
      voiceWakeLoopRef.current = false;
    }
    sendFromVoiceWakeRef.current = false;

    const activeModel = getActiveModel();
    if (!activeModel) {
      showWarning('chat.configureModel');
      return;
    }

    /** 全程固定会话 id，避免压缩异步期间切会话写串 */
    const sendSessionId = currentSessionId;
    if (!tryClaimSessionSend(sendSessionId)) return;

    const uploadedFiles: FileInfo[] = [];

    try {
      if (attachments.attachments.length > 0) {
        let uploadFailed = 0;
        for (const file of attachments.attachments) {
          try {
            const buffer = await file.arrayBuffer();
            const info = await window.electron.uploadFile({
              name: file.name,
              buffer: Array.from(new Uint8Array(buffer)),
              type: file.type,
              size: file.size,
            });
            uploadedFiles.push(info);
          } catch (e) {
            console.error('上传附件失败', e);
            uploadFailed += 1;
          }
        }
        if (uploadedFiles.length === 0) {
          showError('chat.attachmentsUploadFailed');
          clearLoadingForSession(sendSessionId);
          return;
        }
        if (uploadFailed > 0) {
          showWarning('chat.attachmentsUploadPartial', { count: uploadFailed });
        }
      }

      const att = t('chat.attachment');
      const textContent = input.trim() || (uploadedFiles.length > 0 ? att : '');

      stickToBottomRef.current = true;
      const webOn = currentSession
        ? effectiveWebEnabled(currentSession, webSearchEnabled)
        : webSearchEnabled;

      setInput('');
      attachments.clearAttachments();
      requestAnimationFrame(() => inputAreaRef.current?.focus());

      await commitUserMessageAndReply({
        sessionId: sendSessionId,
        textContent,
        files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        model: activeModel,
        locale: uiLocale === 'en' ? 'en' : 'zh',
        summaryTitle: t('chat.contextSummaryTitle'),
        webEnabled: webOn,
        attachmentTitle: t('chat.attachmentTitle'),
        newSessionTitle: t('session.newTitle'),
        runModelReply,
        onDidCompress: () => {
          requestAnimationFrame(() => {
            const el = scrollContainerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          });
        },
      });
    } catch (e) {
      clearLoadingForSession(sendSessionId);
      console.error('[handleSend]', e);
      const detail = e instanceof Error ? e.message : String(e);
      showError('chat.sendFailed', { detail });
    }
  };

  const handleSubmitEditedMessage = async (sourceMessage: Message, nextContent: string) => {
    const textContent = nextContent.trim();
    if (!textContent || !currentSessionId) return;

    const activeModel = getActiveModel();
    if (!activeModel) {
      showWarning('chat.configureModel');
      return;
    }

    const sendSessionId = currentSessionId;
    if (messages.findIndex((m) => m.id === sourceMessage.id) < 0) return;

    const webOn = currentSession
      ? effectiveWebEnabled(currentSession, webSearchEnabled)
      : webSearchEnabled;

    try {
      stickToBottomRef.current = true;
      const result = await resubmitEditedUserMessage({
        sessionId: sendSessionId,
        messageId: sourceMessage.id,
        textContent,
        model: activeModel,
        locale: uiLocale === 'en' ? 'en' : 'zh',
        summaryTitle: t('chat.contextSummaryTitle'),
        webEnabled: webOn,
        runModelReply,
      });
      if (!result.ok) return;
      setEditingMessageId(null);
    } catch (e) {
      clearLoadingForSession(sendSessionId);
      console.error('[handleSubmitEditedMessage]', e);
      const detail = e instanceof Error ? e.message : String(e);
      showError('chat.sendFailed', { detail });
    }
  };

  /** 每次渲染同步最新 handleSend 到 ref */
  handleSendRef.current = () => {
    void handleSend();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    const native = e.nativeEvent;
    if (native.isComposing || imeComposingRef.current) return;
    if ((native as KeyboardEvent).keyCode === 229) return;
    e.preventDefault();
    void handleSend();
  };

  // ===== 派生（显示用） =====
  const webEffective =
    currentSession != null
      ? effectiveWebEnabled(currentSession, webSearchEnabled)
      : false;

  const attachmentStripH = 80;
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;

  /** 流式：最后是助手且无正文时需要「···」，但若已有思考内容则在主气泡内显示，避免双重气泡 */
  const assistantNeedsDots =
    isStreaming && lastMsg?.role === 'assistant' && !(lastMsg.content ?? '').trim().length;
  const thinkingVisibleWhileWaiting =
    assistantNeedsDots && !!(lastMsg?.reasoning ?? '').trim().length;

  const showTypingDots =
    isCurrentSessionLoading &&
    (lastMsg?.role === 'user' || (assistantNeedsDots && !thinkingVisibleWhileWaiting));

  // ===== 上下文进度（computed；estimateSessionChars 遍历全部消息，memo 避免击键/流式期间重算） =====
  const activeModel = getActiveModel();
  const { fullAt, softLimit, overhead, stored, truncateRisk } = useMemo(() => {
    const webOnForCtx = currentSession
      ? effectiveWebEnabled(currentSession, webSearchEnabled)
      : webSearchEnabled;
    const extras = resolveInjectExtras({ webEnabled: webOnForCtx });
    return {
      fullAt: resolveContextProgressFullChars(activeModel ?? null),
      softLimit: resolveContextSoftLimitChars(activeModel ?? null),
      overhead: estimateInjectedPayloadOverheadChars(extras),
      stored: estimateSessionChars(messages, input),
      truncateRisk: messagesExceedSanitizeLimit(messages),
    };
  }, [activeModel, currentSession, webSearchEnabled, messages, input]);

  // ===== 渲染 =====
  return (
    <div
      className="flex flex-col h-full min-h-0"
      onDragOver={attachments.handleDragOver}
      onDragLeave={attachments.handleDragLeave}
      onDrop={attachments.handleDrop}
    >
      {vectorRagStatus?.tone === 'error' ? (
        <div
          className={
            'shrink-0 border-b px-6 py-2.5 text-[11px] leading-relaxed antialiased ' +
            'border-red-200/80 bg-red-50 text-red-900 dark:border-red-500/35 dark:bg-red-950/50 dark:text-red-100'
          }
          role="alert"
        >
          {vectorRagStatus.text}
        </div>
      ) : null}

      <ChatToolbar
        visible={!!currentSessionId && !!currentSession}
        webEffective={webEffective}
        onWebChange={(v) => currentSessionId && setSessionWebOverride(currentSessionId, v ? 'on' : 'off')}
        webSwitchLabel={t('chat.webSwitch')}
        webLabel={t('chat.web')}
        selectionMode={selection.selectionMode}
        selectedCount={selection.selectedMessageIds.size}
        isCurrentSessionLoading={isCurrentSessionLoading}
        messagesEmpty={messages.length === 0}
        onDeleteSelected={handleDeleteSelected}
        onCancelSelection={selection.cancelSelection}
        onStartSelection={() => selection.startSelection()}
        onExport={handleExport}
        selectedCountLabel={t('chat.selectedCount', { count: selection.selectedMessageIds.size })}
        deleteSelectedLabel={t('chat.deleteSelected')}
        cancelSelectLabel={t('chat.cancelSelect')}
        selectMessagesLabel={t('chat.selectMessages')}
        exportMdTitle={t('chat.export.md')}
        exportHtmlTitle={t('chat.export.html')}
      />

      <MessageStream
        scrollContainerRef={scrollContainerRef}
        messages={messages}
        isStreaming={isStreaming}
        streamingTargetAssistantId={streamingTargetAssistantId}
        selectionMode={selection.selectionMode}
        selectedMessageIds={selection.selectedMessageIds}
        onToggleSelect={selection.toggleMessageSelection}
        onStartSelect={selection.startSelection}
        onEdit={handleEditMessage}
        editingMessageId={editingMessageId}
        onSubmitEdit={handleSubmitEditedMessage}
        onCancelEdit={cancelEdit}
        imageGenProgress={imageGenProgress}
        conversationGallery={conversationGallery}
        onOpenConversationGallery={(messageId, fileIndex) => {
          const idx = findConversationGalleryIndex(conversationGallery, messageId, fileIndex);
          if (idx >= 0) {
            setConversationGalleryIdx(idx);
            setConversationGalleryNonce((n) => n + 1);
          }
        }}
        showTypingDots={showTypingDots}
        isCompressingCurrent={isCompressingCurrent}
        footerH={footerH}
        attachmentStripH={attachmentStripH}
        attachmentsLength={attachments.attachments.length}
        emptyLabel={t('chat.empty')}
        newConversationDividerLabel={t('chat.newConversationDivider')}
        compressingLabel={t('chat.compressingContext')}
      />

      {attachments.isDragging && (
        <div className="fixed inset-0 z-50 bg-primary-500/10 backdrop-blur-sm flex items-center justify-center border-4 border-dashed border-primary-400 m-4 rounded-2xl">
          <p className="text-2xl font-bold text-primary-600 dark:text-primary-400">{t('chat.dropHint')}</p>
        </div>
      )}

      <ChatComposer
        attachments={attachments.attachments}
        attachmentPreviews={attachments.attachmentPreviews}
        fileInputRef={attachments.fileInputRef}
        onFileInputClick={() => attachments.fileInputRef.current?.click()}
        onFileInputChange={attachments.handleFileInput}
        onRemoveAttachment={attachments.removeAttachment}
        input={input}
        setInput={setInput}
        inputAreaRef={inputAreaRef}
        onInputKeyDown={handleInputKeyDown}
        onCompositionStart={() => {
          imeComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          imeComposingRef.current = false;
        }}
        isSessionBusy={isSessionBusy}
        inputPlaceholder={t('chat.inputPh')}
        speechInputEnabled={speechInputEnabled}
        speechSupported={speechDictation.supported}
        speechListening={speechDictation.listening}
        speechStarting={speechDictation.starting}
        speechBanner={speechDictation.banner ?? null}
        onSpeechToggle={() => speechDictation.toggle()}
        onSpeechClearBanner={() => speechDictation.clearBanner()}
        voiceWakeListening={voiceWake.listening}
        voiceWakeStarting={voiceWake.starting}
        voiceWakePhrase={voiceWakePhrase}
        setVoiceWakeLoop={(v) => {
          voiceWakeLoopRef.current = v;
        }}
        voiceStopTitle={t('chat.voiceStopTitle')}
        voiceStartingLabel={t('chat.voiceStarting')}
        voiceInputLabel={t('chat.voiceInput')}
        voiceListeningTitle={t('chat.voiceListening')}
        speechNotSupportedLabel={t('chat.speechNotSupported')}
        voiceWakeListeningHint={t('chat.voiceWakeListening', {
          phrase: voiceWakePhrase.trim() || voiceWakePhrase,
        })}
        voiceWakeStartingLabel={t('chat.voiceWakeStarting')}
        closeLabel={t('app.close')}
        stored={stored}
        overhead={overhead}
        softLimit={softLimit}
        fullAt={fullAt}
        truncateRisk={truncateRisk}
        contextUsageHintTemplate={t('chat.contextUsageHint')}
        contextSanitizeWarn={t('chat.contextSanitizeWarn')}
        onSend={() => void handleSend()}
        onStop={handleStop}
        showStop={isCurrentSessionLoading && (isStreaming || !!imageGenProgress)}
        sendLabel={t('chat.send')}
        sendTitle={t('chat.sendTitle')}
        stopLabel={t('chat.stop')}
        stopTitle={t('chat.stopTitle')}
        removeFileLabel={t('chat.removeFile')}
        attachmentsAriaLabel={t('chat.attachments')}
        uploadFileLabel={t('chat.uploadFile')}
        footerH={footerH}
      />

      <GalleryModal
        slides={conversationGallery}
        startIndex={conversationGalleryIdx}
        nonce={conversationGalleryNonce}
        resetKey={currentSessionId ?? 'sess'}
        onClose={() => setConversationGalleryIdx(null)}
      />
    </div>
  );
};

export default ChatWindow;