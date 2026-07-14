import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { useParticleStore } from '../store/particleStore';
import { useI18n } from '../hooks/useI18n';
import { Message, ChatSession, FileInfo, ModelConfig } from '../types';
import { FiPaperclip, FiFile, FiImage, FiSquare, FiDownload, FiGlobe, FiLoader, FiMic, FiTrash2, FiCheckSquare, FiX } from 'react-icons/fi';
import MessageItem, { ConversationImageGalleryModal } from './MessageItem';
import {
  buildConversationImageGallery,
  findConversationGalleryIndex,
} from '@/utils/conversationImageGallery';
import ModelSelector from './ModelSelector';
import { IosSwitch } from './IosSwitch';
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
import AgentBrowserPanel from './AgentBrowserPanel';
import {
  estimateSessionChars,
  resolveContextProgressFullChars,
} from '../utils/contextBudget';
import { resolveContextSoftLimitChars } from '../utils/inferContextWindow';
import { ensureContextBeforeSend } from '../chat/ensureContextBeforeSend';
import {
  estimateInjectedPayloadOverheadChars,
  messagesExceedSanitizeLimit,
} from '../chat/payloadBoundary';
import {
  addFullTextBypassIfNeeded,
  resolveInjectExtras,
  tryClaimSessionSend,
} from '../chat/sendPipeline';
import { resubmitEditedUserMessage } from '../chat/resubmitEditedUserMessage';
import { runModelReply as executeModelReply, type RunModelReplyUi } from '../chat/runModelReply';
import { installRemoteChatBridge } from '../chat/remoteBridge';


const ChatWindow: React.FC<{ footerH?: number }> = ({ footerH = 76 }) => {
  const {
    currentSessionId,
    sessions,
    addMessage,
    removeMessage,
    removeMessages,
    updateMessage,
    appendToMessage,
    appendReasoningToMessage,
    loadingSessionId,
    loadingSessionIds,
    clearLoadingForSession,
    updateSessionTitle,
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

  const isCurrentSessionLoading =
    loadingSessionId !== null && loadingSessionIds.includes(currentSessionId ?? '');
  const isCompressingCurrent =
    !!currentSessionId && compressingSessionIds.includes(currentSessionId);
  const isSessionBusy = isCurrentSessionLoading || isCompressingCurrent;
  const { getActiveModel } = useModelStore();
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 距底部小于该值视为「在底部」，流式输出时可自动跟随滚动 */
  const SCROLL_STICK_BOTTOM_PX = 120;
  const stickToBottomRef = useRef(true);
  const [inlineImageIndex, setInlineImageIndex] = useState(0);
  const [streamingTargetAssistantId, setStreamingTargetAssistantId] = useState<string | null>(null);
  const inlineImageIndexRef = useRef(0);
  inlineImageIndexRef.current = inlineImageIndex;
  const [isStreaming, setIsStreaming] = useState(false);
  /** 本地/HTTP 生图进行中：对话区占位，避免长耗时无反馈 */
  const [imageGenProgress, setImageGenProgress] = useState<{
    current: number;
    total: number;
    messageId: string;
  } | null>(null);
  const [vectorRagStatus, setVectorRagStatus] = useState<{
    text: string;
    tone: 'success' | 'info' | 'error';
  } | null>(null);
  const streamUnsubRef = useRef<(() => void) | null>(null);
  const streamHadErrorRef = useRef(false);
  const imageGenCancelledRef = useRef(false);
  /** 用户点击中止后 onEnd 中用于区分「无输出取消」（删气泡）与「有错结束」 */
  const streamCancelledByUserRef = useRef(false);
  const streamingAssistantIdRef = useRef<string | null>(null);
  /** 当前流式回复所属会话；切会话时点阵不误绑其他会话 */
  const streamingSessionIdRef = useRef<string | null>(null);
  /** 中文/日文等 IME 组字中为 true，避免 Enter 上屏时被当成发送 */
  const imeComposingRef = useRef(false);

  /** 与本机 UI 同步：把生图进度写入消息，便于远端壳页快照显示占位格 */
  const imageGenSyncRef = useRef<{ sessionId: string; messageId: string } | null>(null);

  /** 语音识别：与 input 同步，避免 onresult 闭包陈旧 */
  const inputSyncRef = useRef('');
  inputSyncRef.current = input;
  const handleSendRef = useRef<() => void>(() => {});
  const sendFromVoiceWakeRef = useRef(false);
  const speechReaderRef = useRef<StreamingSpeechReader | null>(null);
  const [voiceReplySpeaking, setVoiceReplySpeaking] = useState(false);
  /** 本轮回复是否来自语音唤醒闭环（唤醒听写自动发送） */
  const voiceWakeLoopRef = useRef(false);
  /** 唤醒态：唤醒词命中到发送/超时之间；驱动粒子呼吸 */
  const [voiceAwake, setVoiceAwake] = useState(false);

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

  const speechDictation = useWebSpeechDictation({
    inputValueRef: inputSyncRef,
    textareaRef: inputAreaRef,
    setInput,
    uiLocale,
    disabled: isSessionBusy || !speechInputEnabled,
    isImeComposing: () => imeComposingRef.current,
    labels: speechLabels,
    getVolcAsrConfig: () => {
      const s = useSettingStore.getState();
      if (!s.speechInputEnabled) return null;
      return {
        appKey: s.volcAsrAppKey,
        accessKey: s.volcAsrAccessKey,
        resourceId: s.volcAsrResourceId,
      };
    },
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
    getVolcAsrConfig: () => {
      const s = useSettingStore.getState();
      if (!s.speechInputEnabled) return null;
      return {
        appKey: s.volcAsrAppKey,
        accessKey: s.volcAsrAccessKey,
        resourceId: s.volcAsrResourceId,
      };
    },
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
   * 业务态 → ParticleStore.agentActivity 派生：
   * - isStreaming + 当前流消息内容为空 → thinking（思考中，旋转）
   * - isStreaming + 已有内容 → replying（回复中，呼吸）
   * - 非流式 + voiceAwake → awake（唤醒等待，呼吸）
   * - 其余 → idle
   * 手势期间由 store.gestureOverride 接管，ParticleField 会自动让 activity 派生静默。
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
    return () => {
      streamUnsubRef.current?.();
      streamUnsubRef.current = null;
      cancelVoiceReply();
      try {
        window.electron?.closeModelStream?.();
      } catch {
        /* ignore */
      }
    };
  }, [cancelVoiceReply]);

  useEffect(() => {
    if (systemTtsAvailable !== false) return;
    const s = useSettingStore.getState();
    if (s.voiceReplyEnabled) s.setVoiceReplyEnabled(false);
  }, [systemTtsAvailable]);

  const currentSession = sessions.find((s: ChatSession) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];
  const conversationGallery = useMemo(() => buildConversationImageGallery(messages), [messages]);
  /**
   * 新对话分隔线：同一会话内，若最后两条消息间隔超过阈值，在间隔处显示一条"以下为新对话内容"。
   * 只保留最近一条断点（从后往前找第一个满足条件的）。阈值 15 分钟，参考同类软件普遍设计。
   */
  const newConversationDividerIndex = useMemo(() => {
    const GAP_MS = 15 * 60 * 1000; // 15 分钟
    if (messages.length < 2) return -1;
    for (let i = messages.length - 1; i >= 1; i--) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (
        typeof prev?.timestamp === 'number' &&
        typeof curr?.timestamp === 'number' &&
        curr.timestamp - prev.timestamp >= GAP_MS
      ) {
        return i;
      }
    }
    return -1;
  }, [messages]);
  const [conversationGalleryIdx, setConversationGalleryIdx] = useState<number | null>(null);
  const [conversationGalleryNonce, setConversationGalleryNonce] = useState(0);

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

  const runModelReply = useCallback(
    (sid: string, hist: Message[], user: Message, model: ModelConfig) => {
      const ui: RunModelReplyUi = {
        locale: uiLocale,
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
        addMessage,
        updateMessage,
        appendToMessage,
        appendReasoningToMessage,
        removeMessage,
        clearLoadingForSession,
      };
      return executeModelReply(ui, sid, hist, user, model);
    },
    [
      addMessage,
      appendReasoningToMessage,
      appendToMessage,
      clearLoadingForSession,
      removeMessage,
      updateMessage,
      t,
      uiLocale,
      consumeVoiceWakeReply,
    ]
  );

  const runModelReplyRef = useRef(runModelReply);
  runModelReplyRef.current = runModelReply;

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

  const startSelection = (messageId?: string) => {
    setSelectionMode(true);
    setSelectedMessageIds(messageId ? new Set([messageId]) : new Set());
  };

  const toggleMessageSelection = (messageId: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  };

  const deleteSelectedMessages = () => {
    if (!currentSessionId || selectedMessageIds.size === 0) return;
    if (!window.confirm(t('chat.confirmDeleteMessages', { count: selectedMessageIds.size }))) return;
    if (editingMessageId && selectedMessageIds.has(editingMessageId)) setEditingMessageId(null);
    removeMessages(currentSessionId, [...selectedMessageIds]);
    cancelSelection();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      const files = Array.from(e.dataTransfer.files);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files as FileList);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    if (removed && removed.name in attachmentPreviews) {
      URL.revokeObjectURL(attachmentPreviews[removed.name]);
      setAttachmentPreviews((p) => {
        const np = { ...p };
        delete np[removed.name];
        return np;
      });
    }
  };

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [currentSessionId]);

  /** 出现生图占位时贴底，减少「卡住」体感 */
  useLayoutEffect(() => {
    if (!imageGenProgress || !stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [imageGenProgress]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const syncStickToBottom = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_STICK_BOTTOM_PX;
    };
    el.addEventListener('scroll', syncStickToBottom, { passive: true });
    syncStickToBottom();
    return () => el.removeEventListener('scroll', syncStickToBottom);
  }, [currentSessionId]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentSessionId]);

  useEffect(() => {
    return () => {
      Object.values(attachmentPreviews).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [attachmentPreviews]);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electron : undefined;
    if (!api?.onMessage) return;
    const off = api.onMessage('myagent-clipboard-paste', (clip: string) => {
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
    if ((!input.trim() && attachments.length === 0) || !currentSessionId) return;

    cancelVoiceReply();
    if (!sendFromVoiceWakeRef.current) {
      voiceWakeLoopRef.current = false;
    }
    sendFromVoiceWakeRef.current = false;

    const activeModel = getActiveModel();
    if (!activeModel) {
      alert(t('chat.configureModel'));
      return;
    }

    /** 全程固定会话 id，避免压缩异步期间切会话写串 */
    const sendSessionId = currentSessionId;
    if (!tryClaimSessionSend(sendSessionId)) return;

    const uploadedFiles: FileInfo[] = [];

    try {
      if (attachments.length > 0) {
        let uploadFailed = 0;
        for (const file of attachments) {
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
          window.alert(uiLocale === 'en' ? 'Attachment upload failed. Please try again.' : '附件上传失败，请重试。');
          clearLoadingForSession(sendSessionId);
          return;
        }
        if (uploadFailed > 0) {
          window.alert(
            uiLocale === 'en'
              ? `${uploadFailed} attachment(s) failed to upload and were skipped.`
              : `有 ${uploadFailed} 个附件上传失败，已忽略失败项继续发送。`
          );
        }
      }

      const att = t('chat.attachment');
      const textContent = input.trim() || (uploadedFiles.length > 0 ? att : '');

      let priorMessages =
        useChatStore.getState().sessions.find((s) => s.id === sendSessionId)?.messages ?? messages;

      stickToBottomRef.current = true;
      const webOn = currentSession
        ? effectiveWebEnabled(currentSession, webSearchEnabled)
        : webSearchEnabled;
      const ensured = await ensureContextBeforeSend({
        sessionId: sendSessionId,
        priorMessages,
        draftInput: textContent,
        model: activeModel,
        locale: uiLocale === 'en' ? 'en' : 'zh',
        summaryTitle: t('chat.contextSummaryTitle'),
        injectExtras: resolveInjectExtras({ webEnabled: webOn }),
      });
      priorMessages = ensured.priorMessages;
      if (ensured.didCompress) {
        requestAnimationFrame(() => {
          const el = scrollContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }

      if (priorMessages.length === 0) {
        const title = (textContent === att ? t('chat.attachmentTitle') : textContent) || t('session.newTitle');
        updateSessionTitle(
          sendSessionId,
          title.length > 15 ? title.substring(0, 15) + '...' : title
        );
      }

      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: textContent,
        files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        timestamp: Date.now(),
        model: activeModel.name,
      };

      addMessage(sendSessionId, userMessage);
      setInput('');
      setAttachments([]);
      setAttachmentPreviews({});
      requestAnimationFrame(() => inputAreaRef.current?.focus());

      if (
        addFullTextBypassIfNeeded({
          sessionId: sendSessionId,
          modelName: activeModel.name,
          textContent,
          hasAttachments: uploadedFiles.length > 0,
        })
      ) {
        return;
      }

      await runModelReply(sendSessionId, priorMessages, userMessage, activeModel);
    } catch (e) {
      clearLoadingForSession(sendSessionId);
      console.error('[handleSend]', e);
      const detail = e instanceof Error ? e.message : String(e);
      window.alert(t('chat.sendFailed') + detail);
    }
  };

  const handleSubmitEditedMessage = async (sourceMessage: Message, nextContent: string) => {
    const textContent = nextContent.trim();
    if (!textContent || !currentSessionId) return;

    const activeModel = getActiveModel();
    if (!activeModel) {
      alert(t('chat.configureModel'));
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
      if (!result.ok) {
        if (result.reason === 'busy') return;
        return;
      }
      setEditingMessageId(null);
    } catch (e) {
      clearLoadingForSession(sendSessionId);
      console.error('[handleSubmitEditedMessage]', e);
      const detail = e instanceof Error ? e.message : String(e);
      window.alert(t('chat.sendFailed') + detail);
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

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, currentSessionId, showTypingDots, vectorRagStatus, footerH, attachments.length, isCompressingCurrent]);

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {currentSessionId && currentSession && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-stone-600/20 px-6 py-2 dark:border-white/10 bg-stone-100/50 dark:bg-slate-900/40">
          <div className="flex items-center gap-2.5 text-xs text-stone-600 dark:text-slate-400">
            <div className="flex items-center gap-1.5">
              <FiGlobe size={14} className="shrink-0" aria-hidden />
              <span>{t('chat.web')}</span>
            </div>
            <IosSwitch
              checked={webEffective}
              aria-label={t('chat.webSwitch')}
              onChange={(v) => setSessionWebOverride(currentSessionId, v ? 'on' : 'off')}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            {selectionMode ? (
              <>
                <span className="mr-1 text-xs text-stone-500 dark:text-slate-400">
                  {t('chat.selectedCount', { count: selectedMessageIds.size })}
                </span>
                <button
                  type="button"
                  onClick={deleteSelectedMessages}
                  disabled={selectedMessageIds.size === 0 || isCurrentSessionLoading}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45 dark:text-red-300 dark:hover:bg-red-950/45"
                  title={t('chat.deleteSelected')}
                >
                  <FiTrash2 size={14} /> {t('chat.deleteSelected')}
                </button>
                <button
                  type="button"
                  onClick={cancelSelection}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
                  title={t('chat.cancelSelect')}
                >
                  <FiX size={14} /> {t('chat.cancelSelect')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => startSelection()}
                disabled={messages.length === 0 || isCurrentSessionLoading}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300 dark:hover:bg-slate-800"
                title={t('chat.selectMessages')}
              >
                <FiCheckSquare size={14} /> {t('chat.selectMessages')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleExport('md')}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('chat.export.md')}
            >
              <FiDownload size={14} /> MD
            </button>
            <button
              type="button"
              onClick={() => void handleExport('html')}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('chat.export.html')}
            >
              <FiDownload size={14} /> HTML
            </button>
          </div>
        </div>
      )}

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

      <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        data-gesture-scroll-target="chat"
        className="min-h-0 flex-1 overflow-y-auto px-8 py-4 space-y-4"
        style={{
          paddingBottom: `calc(${footerH + (attachments.length > 0 ? attachmentStripH : 0)}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-64 text-stone-400 dark:text-slate-500">
            <p className="text-lg">{t('chat.emptyChat')}</p>
          </div>
        )}

        {messages.map((message, index) => {
          const reasoningTrim = (message.reasoning ?? '').trim();
          const hideEmptyStreamBubble =
            isStreaming &&
            message.role === 'assistant' &&
            message.id === streamingTargetAssistantId &&
            !(message.content ?? '').trim().length &&
            !reasoningTrim.length;
          if (hideEmptyStreamBubble) return <React.Fragment key={message.id} />;
          return (
          <React.Fragment key={message.id}>
            {index === newConversationDividerIndex && (
              <div className="flex items-center gap-3 py-1" role="separator" aria-label={t('chat.newConversationDivider')}>
                <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
                <span className="text-[10px] font-medium text-stone-400 dark:text-slate-500 whitespace-nowrap">
                  {t('chat.newConversationDivider')}
                </span>
                <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
              </div>
            )}
          <MessageItem
            key={message.id}
            message={message}
              onEdit={message.role === 'user' ? handleEditMessage : undefined}
              editing={editingMessageId === message.id}
              onSubmitEdit={handleSubmitEditedMessage}
              onCancelEdit={cancelEdit}
              selectionMode={selectionMode}
              selected={selectedMessageIds.has(message.id)}
              onToggleSelect={toggleMessageSelection}
              onStartSelect={startSelection}
              conversationStreaming={isStreaming}
              streamingAssistantId={streamingTargetAssistantId}
              showInlineStreamPlaceholder={
                !!isStreaming &&
                message.role === 'assistant' &&
                message.id === streamingTargetAssistantId &&
                !(message.content ?? '').trim().length &&
                !!(message.reasoning ?? '').trim().length
              }
              conversationGallery={conversationGallery}
              onOpenConversationGallery={(messageId, fileIndex) => {
                const idx = findConversationGalleryIndex(conversationGallery, messageId, fileIndex);
                if (idx >= 0) {
                  setConversationGalleryIdx(idx);
                  setConversationGalleryNonce((n) => n + 1);
                }
              }}
              imageGenProgress={
                imageGenProgress?.messageId === message.id
                  ? { current: imageGenProgress.current, total: imageGenProgress.total }
                  : message.imageGenProgress
              }
            />
          </React.Fragment>
          );
        })}

        {showTypingDots && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 text-stone-500 dark:text-slate-500 text-sm px-5 py-3.5 bg-stone-100 dark:bg-slate-800 rounded-2xl rounded-tl-sm border border-stone-300/45 dark:border-white/5">
              <div className="flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
                  ·
                </span>
              </div>
            </div>
          </div>
        )}

        {isCompressingCurrent ? (
          <div
            className="flex items-center gap-3 py-2"
            role="status"
            aria-live="polite"
            aria-label={t('chat.compressingContext')}
          >
            <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-stone-500 dark:text-slate-400 whitespace-nowrap">
              <FiLoader size={12} className="animate-spin shrink-0 opacity-80" aria-hidden />
              {t('chat.compressingContext')}
            </span>
            <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
          </div>
        ) : null}

        <div ref={messagesEndRef} />
      </div>
      <AgentBrowserPanel />
      </div>

      {isDragging && (
        <div className="fixed inset-0 z-50 bg-primary-500/10 backdrop-blur-sm flex items-center justify-center border-4 border-dashed border-primary-400 m-4 rounded-2xl">
          <p className="text-2xl font-bold text-primary-600 dark:text-primary-400">{t('chat.dropHint')}</p>
        </div>
      )}

      <div
        className="fixed bottom-0 right-0 z-30 flex w-[calc(100%-256px)] min-w-0 flex-col border-t border-stone-600/38 bg-stone-200/92 backdrop-blur-xl dark:border-white/10 dark:bg-[#0B1120]/80"
        style={{ left: 256, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {attachments.length > 0 && (
          <div
            className="flex shrink-0 flex-wrap justify-start gap-2 border-b border-stone-600/25 bg-transparent px-6 py-1.5 dark:border-white/10"
            aria-label={t('chat.attachments')}
          >
            {attachments.map((file, index) => {
              const preview = attachmentPreviews[file.name];
              const isImage = file.type.startsWith('image/');
              const showThumb = isImage && !!preview;
              return (
                <div
                  key={`${file.name}-${index}`}
                  className="relative flex w-[92px] shrink-0 flex-col items-center gap-1 rounded-lg border border-primary-400/55 bg-transparent px-1 pb-1.5 pt-1 dark:border-primary-500/45"
                >
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-stone-400/50 bg-stone-100 text-[11px] leading-none text-stone-600 shadow-sm hover:bg-stone-200 dark:border-white/20 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    title={t('chat.removeFile')}
                  >
                    ×
                  </button>
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-primary-500/70 bg-stone-100/80 shadow-sm dark:border-primary-400/60 dark:bg-slate-900/40">
                    {showThumb ? (
                      <img src={preview} alt="" className="h-full w-full object-cover" />
                    ) : isImage ? (
                      <FiImage className="text-stone-400 dark:text-slate-500" size={22} aria-hidden />
                    ) : (
                      <FiFile className="text-stone-600 dark:text-slate-300" size={22} aria-hidden />
                    )}
                  </div>
                  <span className="w-full truncate px-0.5 text-center text-[10px] font-medium leading-tight text-stone-800 dark:text-slate-100">
                    {file.name}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div
          className="relative box-border flex min-h-0 w-full min-w-0 flex-col gap-2 px-6 py-1.5 sm:py-2"
          style={{ minHeight: footerH }}
        >
          {speechInputEnabled && speechDictation.banner ? (
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-amber-50/90 px-3 py-1.5 text-xs text-amber-950 dark:border-amber-600/35 dark:bg-amber-950/45 dark:text-amber-50">
              <span className="min-w-0 leading-snug">{speechDictation.banner}</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium opacity-80 hover:opacity-100"
                onClick={() => speechDictation.clearBanner()}
              >
                {t('app.close')}
              </button>
            </div>
          ) : null}
        {(() => {
          const active = getActiveModel();
          /** 满格 = 压缩触发线（soft×95%），与发送前门禁对齐 */
          const fullAt = resolveContextProgressFullChars(active);
          const softLimit = resolveContextSoftLimitChars(active);
          const webOn = currentSession
            ? effectiveWebEnabled(currentSession, webSearchEnabled)
            : webSearchEnabled;
          const extras = resolveInjectExtras({ webEnabled: webOn });
          const overhead = estimateInjectedPayloadOverheadChars(extras);
          const stored = estimateSessionChars(messages, input);
          const totalLength = stored + overhead;
          const fillPerc = Math.min((totalLength / Math.max(1, fullAt)) * 100, 100);
          const isNearLimit = fillPerc > 80;
          const truncateRisk = messagesExceedSanitizeLimit(messages);
          const softPct = Math.round(Math.min((totalLength / Math.max(1, softLimit)) * 100, 100));
          const baseHint = t('chat.contextUsageHint', {
            used: Math.round(totalLength / 1000),
            limit: Math.round(softLimit / 1000),
            pct: softPct,
          });
          const title = truncateRisk ? `${baseHint} · ${t('chat.contextSanitizeWarn')}` : baseHint;
          return totalLength > 0 ? (
            <div
                className={`absolute top-0 left-0 h-[2px] transition-all duration-300 ${
                  isNearLimit || truncateRisk ? 'bg-orange-500' : 'bg-gradient-to-r from-primary-400 to-teal-500'
                }`}
              style={{ width: `${fillPerc}%` }}
              title={title}
            />
          ) : null;
        })()}

          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileInput}
            className="hidden"
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.md,.markdown,.txt,.csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          />

          <div className="flex min-h-[2.5rem] w-full min-w-0 flex-1 items-center gap-2">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-2xl border border-stone-400/28 bg-stone-100/95 py-0 pl-1.5 pr-1 shadow-sm transition-all focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-800/80">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all ${
                  attachments.length > 0
                    ? 'bg-primary-100/80 text-primary-600 dark:bg-primary-900/30'
                    : 'text-stone-500 hover:bg-stone-300/45 dark:text-slate-500 dark:hover:bg-slate-700'
                }`}
                title={t('chat.uploadFile')}
            >
              <FiPaperclip size={14} />
            </button>
              {speechInputEnabled ? (
                <button
                  type="button"
                  aria-pressed={speechDictation.listening}
                  aria-busy={speechDictation.starting}
                  aria-label={
                    speechDictation.listening
                      ? t('chat.voiceStopTitle')
                      : speechDictation.starting
                        ? t('chat.voiceStarting')
                        : voiceWake.listening
                          ? t('chat.voiceWakeListening', { phrase: voiceWakePhrase.trim() || voiceWakePhrase })
                          : t('chat.voiceInput')
                  }
                  disabled={
                    isSessionBusy || !speechDictation.supported || speechDictation.starting
                  }
                  onClick={() => {
                    if (!speechDictation.listening) {
                      voiceWakeLoopRef.current = false;
                    }
                    speechDictation.toggle();
                  }}
                  title={
                    speechDictation.listening
                      ? t('chat.voiceListening')
                      : speechDictation.starting
                        ? t('chat.voiceStarting')
                        : !speechDictation.supported
                          ? t('chat.speechNotSupported')
                          : voiceWake.listening
                          ? t('chat.voiceWakeListeningHint', { phrase: voiceWakePhrase.trim() || voiceWakePhrase })
                          : voiceWake.starting
                            ? t('chat.voiceWakeStarting')
                            : t('chat.voiceInput')
                  }
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all [&_svg]:pointer-events-none ${
                    speechDictation.listening
                      ? 'bg-red-600 text-white shadow-sm shadow-red-500/25 animate-pulse'
                      : speechDictation.starting
                        ? 'cursor-wait text-primary-600 dark:text-primary-400'
                        : isSessionBusy || !speechDictation.supported
                          ? 'cursor-not-allowed text-stone-400 dark:text-slate-600'
                          : voiceWake.listening
                            ? 'text-primary-600 ring-1 ring-primary-400/60 dark:text-primary-400 dark:ring-primary-500/50'
                            : voiceWake.starting
                              ? 'cursor-wait text-primary-600 dark:text-primary-400'
                              : 'text-stone-600 hover:bg-stone-300/55 dark:text-slate-400 dark:hover:bg-slate-700'
                  }`}
                >
                  {speechDictation.starting || voiceWake.starting ? (
                    <FiLoader size={15} className="animate-spin" aria-hidden />
                  ) : (
                    <FiMic size={15} aria-hidden />
                  )}
                </button>
              ) : null}
            <textarea
                ref={inputAreaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => {
                  imeComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  imeComposingRef.current = false;
                }}
              onKeyDown={handleInputKeyDown}
                placeholder={t('chat.inputPlaceholder')}
                className="box-border min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-1 pr-0.5 leading-5 text-stone-800 placeholder-stone-500/70 focus:outline-none dark:text-slate-100 text-[clamp(0.8125rem,0.55vw+0.68rem,0.9375rem)]"
              rows={1}
                style={{ maxHeight: 'min(28vh, 9rem)' }}
              disabled={isSessionBusy}
            />
            <div className="ml-0.5 flex shrink-0 items-center self-stretch border-l border-stone-400/25 pl-1 dark:border-slate-600">
              <ModelSelector compact />
            </div>
          </div>
            {isCurrentSessionLoading && (isStreaming || imageGenProgress) ? (
          <button
            type="button"
                onClick={handleStop}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-xl border border-stone-400/50 bg-stone-100 px-4 text-sm font-medium text-stone-800 hover:bg-stone-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                title={t('chat.stopTitle')}
              >
                <FiSquare size={12} className="shrink-0" />
                {t('chat.stop')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleSend()}
            disabled={!input.trim() && attachments.length === 0}
            className={`inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-5 text-sm font-medium transition-all ${
              input.trim() || attachments.length > 0
                ? 'bg-primary-600 text-white shadow-md shadow-primary-500/20 hover:bg-primary-700'
                : 'cursor-not-allowed bg-stone-300 text-stone-500 dark:bg-slate-700 dark:text-slate-500'
            }`}
              title={t('chat.sendTitle')}
          >
              {t('chat.send')}
          </button>
        </div>
        </div>
      </div>
      {conversationGalleryIdx !== null && conversationGallery.length > 0 ? (
        <ConversationImageGalleryModal
          key={`${currentSessionId ?? 'sess'}-${conversationGalleryNonce}`}
          slides={conversationGallery}
          startIndex={conversationGalleryIdx}
          onClose={() => setConversationGalleryIdx(null)}
        />
      ) : null}
    </div>
  );
};

export default ChatWindow;
