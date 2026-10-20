import { VoiceInteractionBar } from '../features/voiceQuick/VoiceInteractionBar';
import { installQuickChatBridge } from '../features/voiceQuick/quickBridge';
import { cancelImageTask, cancelReplyRun } from '../chat/imageTaskState';
import { cancelVideoForSession } from '../chat/videoGenAssist';
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
import { getActiveMessages, getSiblingNav } from '../utils/branchTree';
import { resolveSendModel } from '../agent/resolveSendModel';
import { newRequestId, rendererLogger } from '../utils/logger';
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
import { IDLE_SESSION_RUN_UI, useSessionRunUi, useSessionStreamRefs } from './ChatWindow/hooks/useChatStreamRefs';
import { useChatRunModelReply } from './ChatWindow/hooks/useChatRunModelReply';
import {
  buildConversationImageGallery,
  findConversationGalleryIndex,
  type ConversationImageGalleryItem,
} from '../utils/conversationImageGallery';
import { FOOTER_H_PX } from '../constants/layout';
import { registerRuntimeTaskExecutor } from '../features/personal/runtimeDispatcher';
import { executeDispatchedRuntimeTask } from '../features/personal/runtimeExecution';
import { createSessionTask, cancelSessionTask, sessionTask } from '../features/runtime/taskBridge';
import { useSessionComposerDrafts } from '../features/personal/useSessionComposerDrafts';

/** 单个附件上限：超大文件一次性读入渲染进程并跨 IPC 复制，会卡死或撑爆内存 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
    forkFromMessage,
    switchBranch,
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
  const { getActiveModel, models, routingRules } = useModelStore();

  // ===== 局部 state（保持原顺序） =====
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  /** 流式、生图进度、检索提示按会话各存一份；界面只展示当前会话 */
  const { runUi, patchRunUi, clearVectorRagStatuses, pruneRunUi } = useSessionRunUi();
  const currentRunUi = (currentSessionId && runUi[currentSessionId]) || IDLE_SESSION_RUN_UI;
  const { isStreaming, streamingTargetAssistantId, imageGenProgress, vectorRagStatus } = currentRunUi;
  const [inlineImageIndex, setInlineImageIndex] = useState(0);
  const inlineImageIndexRef = useRef(0);
  inlineImageIndexRef.current = inlineImageIndex;
  const [voiceReplySpeaking, setVoiceReplySpeaking] = useState(false);
  const [voiceInterruptRequested,setVoiceInterruptRequested] = useState(false);
  const [voiceManualPause,setVoiceManualPause] = useState(false);
  /** 唤醒态：唤醒词命中到发送/超时之间；驱动粒子呼吸 */
  const [voiceAwake, setVoiceAwake] = useState(false);
  const [conversationGalleryIdx, setConversationGalleryIdx] = useState<number | null>(null);
  const [conversationGalleryNonce, setConversationGalleryNonce] = useState(0);

  // ===== refs =====
  const inputAreaRef = useRef<HTMLTextAreaElement>(null);
  /** 流式 ref 集群：每个会话一份，见 useChatStreamRefs */
  const streamRefs = useSessionStreamRefs();
  /** 中文/日文等 IME 组字中为 true，避免 Enter 上屏时被当成发送 */
  const imeComposingRef = useRef(false);
  /** 语音识别：与 input 同步，避免 onresult 闭包陈旧 */
  const inputSyncRef = useRef('');
  inputSyncRef.current = input;
  const handleSendRef = useRef<() => void>(() => {});
  const sendFromVoiceWakeRef = useRef(false);
  const speechReaderRef = useRef<StreamingSpeechReader | null>(null);
  const voiceWakeStartAbortRef = useRef<AbortController|null>(null);
  /** 本轮回复是否来自语音唤醒闭环（唤醒听写自动发送） */
  const voiceWakeLoopRef = useRef(false);

  // ===== 业务派生 =====
  const currentSession = sessions.find((s: ChatSession) => s.id === currentSessionId);
  const allMessages = currentSession?.messages ?? [];
  const messages = useMemo(
    () => getActiveMessages(allMessages, currentSession?.activeLeafId),
    [allMessages, currentSession?.activeLeafId]
  );
  const conversationGallery: ConversationImageGalleryItem[] = useMemo(
    () => buildConversationImageGallery(messages),
    [messages]
  );

  const pickModelForTurn = useCallback(
    (history: Message[], userText: string, hasImages: boolean) => {
      const active = getActiveModel();
      if (!active) return null;
      return resolveSendModel({
        models,
        activeModel: active,
        routingRules,
        history,
        userText,
        hasImages,
      });
    },
    [getActiveModel, models, routingRules]
  );

  // ===== 业务逻辑 =====
  const cancelVoiceReply = useCallback(() => {
    voiceWakeStartAbortRef.current?.abort();voiceWakeStartAbortRef.current=null;
    speechReaderRef.current?.cancel();
    try{window.speechSynthesis?.cancel();}catch{}
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
    enabled: speechInputEnabled && voiceWakeEnabled && !voiceManualPause,
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
      voiceWakeStartAbortRef.current?.abort();const controller=new AbortController();voiceWakeStartAbortRef.current=controller;
      setVoiceAwake(true);
      /** TTS 期间仅预拉麦克风；火山 WebSocket 在 TTS 结束后立即建连并推流 */
      const micPrep = speechDictation.prepareWakeMic();
      void (async () => {
        await Promise.all([
          micPrep,
          ttsPlaybackReady
            ? speakText(t('chat.voiceWakeAck'), uiLocale, { tailSilenceMs: 0, signal:controller.signal })
            : Promise.resolve(),
        ]);
        if(!controller.signal.aborted)speechDictation.start({ fromWake: true });
      })();
    },
  });

  // ===== Hooks（5 个抽出的 hook） =====
  const selection = useMessageSelection();
  const attachments = useChatAttachments();
  const composerDrafts = useSessionComposerDrafts({ sessionId: currentSessionId, input, files: attachments.attachments, setInput, setFiles: attachments.setAttachments, setPreviews: attachments.setAttachmentPreviews });
  const {
    scrollContainerRef,
    stickToBottomRef,
    showScrollToLatest,
    scrollToLatest,
  } = useChatScrollStick({
    currentSessionId: currentSessionId ?? null,
    showTypingDots: false, // 占位：useChatScrollStick 不会因为 showTypingDots 变化触发贴底以外的副作用，调用方在末尾 useLayoutEffect 中处理
    vectorRagStatus,
    footerH,
    attachmentsLength: attachments.attachments.length,
    isCompressingCurrent,
    imageGenProgress,
    messages,
  });
  useChatLifecycleCleanup({ cancelVoiceReply, streamRefs });
  const { runModelReply, runModelReplyRef } = useChatRunModelReply({
    uiLocale,
    t,
    consumeVoiceWakeReply,
    setVoiceReplySpeaking,
    patchRunUi,
    streamRefs,
    setInlineImageIndex,
    inlineImageIndexRef,
    speechReaderRef,
  });

  // ===== 业务 effect（不抽到 hook 的部分） =====
  /** 会话删除后回收其流式 ref 与界面态 */
  const sessionIdsKey = sessions.map((s) => s.id).join('\n');
  useEffect(() => {
    const live = new Set(sessionIdsKey ? sessionIdsKey.split('\n') : []);
    streamRefs.prune(live);
    pruneRunUi(live);
  }, [sessionIdsKey, streamRefs, pruneRunUi]);
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
    /** isStreaming 已是当前会话自己的流式态 */
    if (isStreaming) {
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
    setVoiceInterruptRequested(false);
    setConversationGalleryIdx(null);
    setConversationGalleryNonce(0);
    clearVectorRagStatuses();
    speechDictation.abort();
    cancelVoiceReply();
    voiceWakeLoopRef.current = false;
  }, [currentSessionId, speechDictation.abort, cancelVoiceReply, clearVectorRagStatuses]);

  useEffect(() => {
    if (!currentSessionId || !vectorRagStatus || vectorRagStatus.tone !== 'error') return;
    const sid = currentSessionId;
    const tid = window.setTimeout(() => patchRunUi(sid, { vectorRagStatus: null }), 6500);
    return () => window.clearTimeout(tid);
  }, [currentSessionId, vectorRagStatus, patchRunUi]);

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
  const stopSessionWork = useCallback((sessionId: string) => {
    cancelReplyRun(sessionId);
    cancelVideoForSession(sessionId);
    void cancelSessionTask(sessionId).catch((error) => console.error('[Cancel task]', error));
    const refs = streamRefs.refsFor(sessionId);
    /** 网络已结束但打字机仍在放积压正文时，停止必须立即生效 */
    refs.cancelAnimRef.current?.();
    refs.cancelAnimRef.current = null;
    const ownsStream = refs.streamingSessionIdRef.current === sessionId;
    if (ownsStream) refs.streamCancelledByUserRef.current = true;
    const p = refs.imageGenSyncRef.current;
    if (p?.sessionId === sessionId) {
      refs.imageGenCancelledRef.current = true;
      patchRunUi(sessionId, { imageGenProgress: null });
      cancelImageTask(p.messageId);
      window.electron.cancelImageGeneration?.(p.messageId);
      updateMessage(p.sessionId, p.messageId, { imageGenProgress: undefined });
      refs.imageGenSyncRef.current = null;
    }
    if (ownsStream) {
      /** 订阅返回的函数只中止本会话的流；其他会话的并行流不受影响 */
      refs.streamUnsubRef.current?.();
      refs.streamUnsubRef.current = null;
      patchRunUi(sessionId, { isStreaming: false });
      refs.streamingSessionIdRef.current = null;
    }
    clearLoadingForSession(sessionId);
    /** streamingAssistantIdRef 由 onEnd 清理，便于识别待删空气泡 */
  }, [clearLoadingForSession, updateMessage, streamRefs, patchRunUi]);
  const handleStop = () => { if (currentSessionId) stopSessionWork(currentSessionId); };

  useEffect(() => installQuickChatBridge({runModelReply:(...args)=>runModelReplyRef.current(...args),stopSession:stopSessionWork}), [stopSessionWork]);
  useEffect(() => {
    if(!voiceInterruptRequested||isSessionBusy)return;
    setVoiceInterruptRequested(false);
    if(speechInputEnabled) {voiceWakeLoopRef.current=true;speechDictation.start({fromWake:true});}
  }, [voiceInterruptRequested,isSessionBusy,speechInputEnabled,speechDictation.start]);

  useEffect(() => registerRuntimeTaskExecutor(
    (task) => executeDispatchedRuntimeTask(task, (...args) => runModelReplyRef.current(...args)),
    (taskId) => {
      const target = useChatStore.getState().sessions.find((session) => sessionTask(session.id)?.id === taskId);
      if (target) stopSessionWork(target.id);
    }
  ), [runModelReplyRef, stopSessionWork]);

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

  const handleExport = async (kind: 'md' | 'html' | 'zip') => {
    if (!currentSession) return;
    const safe = (currentSession.title || 'export').replace(/[\\/:"*?<>|]/g, '_');
    if (kind === 'zip') {
      const result = await window.electron.exportSession({
        sessionId: currentSession.id,
        defaultName: safe,
        session: {
          id: currentSession.id,
          title: currentSession.title,
          createdAt: currentSession.createdAt,
          updatedAt: currentSession.updatedAt,
          messages: currentSession.messages,
          activeLeafId: currentSession.activeLeafId ?? null,
        },
      });
      if (!result.ok) {
        if (result.canceled) return;
        showError('chat.export.zipFailed', { detail: result.error });
        return;
      }
      if (result.warnings.length > 0) {
        showWarning('chat.export.zipPartial', { count: result.warnings.length });
      }
      return;
    }
    const content = kind === 'md' ? sessionToMarkdown(currentSession) : sessionToHtml(currentSession);
    const ext = kind === 'md' ? 'md' : 'html';
    await window.electron.saveTextFile({
      defaultName: `${safe}.${ext}`,
      content,
      filters:
        kind === 'md'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
  };

  const handleRegenerate = async (assistantMessage: Message) => {
    if (!currentSessionId || !currentSession || isSessionBusy) return;
    if (assistantMessage.role !== 'assistant') return;
    const parentId = assistantMessage.parentId;
    if (!parentId) return;
    const parent = allMessages.find((m) => m.id === parentId);
    if (!parent || parent.role !== 'user') return;

    const pathBefore = getActiveMessages(allMessages, parentId);
    const history = pathBefore.filter((m) => m.id !== parentId);
    const model = pickModelForTurn(
      history,
      parent.content,
      Boolean(parent.files?.some((f) => f.type?.startsWith('image/')))
    );
    if (!model) {
      showWarning('chat.configureModel');
      return;
    }
    if (!tryClaimSessionSend(currentSessionId)) {
      showWarning('chat.anotherConversationBusy');
      return;
    }

    const requestId = newRequestId();
    rendererLogger.info('chat.regenerate.begin', {
      requestId,
      sessionId: currentSessionId,
      parentId,
      modelId: model.id,
    });

    const sessionId = currentSessionId;
    let forkId: string | null = null;
    try {
      forkId = forkFromMessage(sessionId, parentId);
      stickToBottomRef.current = true;
      await createSessionTask(sessionId,parent,{occurrenceId:requestId});
      if(!useChatStore.getState().isLoadingSession(sessionId))return;
      await runModelReply(sessionId, history, parent, model);
    } catch (e) {
      clearLoadingForSession(sessionId);
      const detail = e instanceof Error ? e.message : String(e);
      showError('chat.sendFailed', { detail });
    } finally {
      /** 未能开始回复时不留下预置的空白气泡 */
      const chat = useChatStore.getState();
      const fork = forkId ? chat.sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === forkId) : undefined;
      if (fork && !chat.isLoadingSession(sessionId) && !fork.content.trim() && !(fork.reasoning ?? '').trim() && !fork.files?.length) {
        chat.removeMessage(sessionId, fork.id);
      }
    }
  };

  const handleSwitchSibling = (messageId: string, direction: -1 | 1) => {
    if (!currentSessionId) return;
    const nav = getSiblingNav(allMessages, messageId);
    if (nav.total <= 1) return;
    const idx = nav.index - 1;
    const next = nav.siblingIds[idx + direction];
    if (!next) return;
    switchBranch(currentSessionId, next);
  };

  const handleSend = async () => {
    if ((!input.trim() && attachments.attachments.length === 0) || !currentSessionId) return;

    cancelVoiceReply();
    if (!sendFromVoiceWakeRef.current) {
      voiceWakeLoopRef.current = false;
    }
    sendFromVoiceWakeRef.current = false;

    /** 全程固定会话 id，避免压缩异步期间切会话写串 */
    const sendSessionId = currentSessionId;
    const draftText = input.trim();
    const draftFiles = [...attachments.attachments];
    if (!tryClaimSessionSend(sendSessionId)) {
      showWarning('chat.anotherConversationBusy');
      return;
    }

    const uploadedFiles: FileInfo[] = [];

    try {
      if (draftFiles.length > 0) {
        let uploadFailed = 0;
        for (const file of draftFiles) {
          if (file.size > MAX_UPLOAD_BYTES) {
            console.warn('附件超过大小上限，已跳过', file.name, file.size);
            uploadFailed += 1;
            continue;
          }
          try {
            const buffer = await file.arrayBuffer();
            const info = await window.electron.uploadFile({
              name: file.name,
              /** 直接传字节视图（结构化克隆支持，主进程 Buffer.from 兼容）；number[] 会让内存膨胀数倍 */
              buffer: new Uint8Array(buffer) as unknown as number[],
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
      const textContent = draftText || (uploadedFiles.length > 0 ? att : '');
      const hasImages = uploadedFiles.some((f) => f.type?.startsWith('image/'));
      const activeModel = pickModelForTurn(messages, textContent, hasImages);
      if (!activeModel) {
        showWarning('chat.configureModel');
        clearLoadingForSession(sendSessionId);
        return;
      }

      const requestId = newRequestId();
      rendererLogger.info('chat.send.begin', {
        requestId,
        sessionId: sendSessionId,
        modelId: activeModel.id,
        messageCount: messages.length,
        hasImages,
      });

      stickToBottomRef.current = true;
      const webOn = currentSession
        ? effectiveWebEnabled(currentSession, webSearchEnabled)
        : webSearchEnabled;

      composerDrafts.clearDraft(sendSessionId);
      if (useChatStore.getState().currentSessionId === sendSessionId) {
        setInput('');
        attachments.clearAttachments();
        requestAnimationFrame(() => inputAreaRef.current?.focus());
      }

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

    const sendSessionId = currentSessionId;
    if (messages.findIndex((m) => m.id === sourceMessage.id) < 0) return;

    const pathIdx = messages.findIndex((m) => m.id === sourceMessage.id);
    const history = pathIdx >= 0 ? messages.slice(0, pathIdx) : [];
    const activeModel = pickModelForTurn(
      history,
      textContent,
      Boolean(sourceMessage.files?.some((f) => f.type?.startsWith('image/')))
    );
    if (!activeModel) {
      showWarning('chat.configureModel');
      return;
    }

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
        onCommitted: () => setEditingMessageId(null),
      });
      if (!result.ok) {
        if (result.reason === 'busy') showWarning('chat.anotherConversationBusy');
        return;
      }
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
      stored: estimateSessionChars(messages, input, activeModel),
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
        exportZipTitle={t('chat.export.zip')}
      />

      <MessageStream
        scrollContainerRef={scrollContainerRef}
        messages={messages}
        allMessages={allMessages}
        isStreaming={isStreaming}
        streamingTargetAssistantId={streamingTargetAssistantId}
        selectionMode={selection.selectionMode}
        selectedMessageIds={selection.selectedMessageIds}
        onToggleSelect={selection.toggleMessageSelection}
        onStartSelect={selection.startSelection}
        onEdit={handleEditMessage}
        onRegenerate={handleRegenerate}
        onSwitchSibling={handleSwitchSibling}
        editingMessageId={editingMessageId}
        onSubmitEdit={handleSubmitEditedMessage}
        onCancelEdit={cancelEdit}
        branchPrevLabel={t('chat.branch.prev')}
        branchNextLabel={t('chat.branch.next')}
        regenerateLabel={t('chat.regenerate')}
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

      <VoiceInteractionBar enabled={speechInputEnabled} listening={speechDictation.listening} starting={speechDictation.starting||voiceWake.starting} thinking={isSessionBusy} speaking={voiceReplySpeaking} wakeListening={voiceWake.listening} wakePhrase={voiceWakePhrase} supported={speechDictation.supported}
        paused={voiceManualPause} onResume={()=>setVoiceManualPause(false)}
        onInterrupt={()=>{setVoiceManualPause(false);cancelVoiceReply();speechDictation.abort();if(currentSessionId&&isSessionBusy)stopSessionWork(currentSessionId);setVoiceInterruptRequested(true);}}
        onStop={()=>{setVoiceManualPause(true);setVoiceInterruptRequested(false);voiceWakeLoopRef.current=false;cancelVoiceReply();speechDictation.abort();if(currentSessionId&&isSessionBusy)stopSessionWork(currentSessionId);}}/>

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
        onSpeechToggle={() => {setVoiceManualPause(false);cancelVoiceReply();speechDictation.toggle();}}
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
        showStop={isCurrentSessionLoading}
        sendLabel={t('chat.send')}
        sendTitle={t('chat.sendTitle')}
        stopLabel={t('chat.stop')}
        stopTitle={t('chat.stopTitle')}
        removeFileLabel={t('chat.removeFile')}
        attachmentsAriaLabel={t('chat.attachments')}
        uploadFileLabel={t('chat.uploadFile')}
        footerH={footerH}
        showScrollToLatest={showScrollToLatest}
        onScrollToLatest={scrollToLatest}
        scrollToLatestLabel={t('chat.scrollToLatest')}
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
