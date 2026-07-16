import { useCallback, useRef } from 'react';
import { runModelReply as executeModelReply, type RunModelReplyUi } from '../../../chat/runModelReply';
import { useChatStore } from '../../../store/chatStore';
import type { Message, ModelConfig } from '../../../types';
import type { Locale } from '../../../i18n/types';
import type { StreamingSpeechReader } from '../../../utils/streamingSpeech';

export interface ChatRunModelReplyApi {
  /** 统一命名为 `runModelReply`（保留公开 API key 名） */
  runModelReply: (sid: string, hist: Message[], user: Message, model: ModelConfig) => Promise<void>;
  runModelReplyRef: React.MutableRefObject<ChatRunModelReplyApi['runModelReply']>;
}

export interface UseChatRunModelReplyParams {
  uiLocale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
  consumeVoiceWakeReply: () => boolean;
  setVoiceReplySpeaking: (v: boolean) => void;
  setVectorRagStatus: (v: {
    text: string;
    tone: 'success' | 'info' | 'error';
  } | null) => void;
  setImageGenProgress: (v: {
    current: number;
    total: number;
    messageId: string;
  } | null) => void;
  setIsStreaming: (v: boolean) => void;
  setStreamingTargetAssistantId: (v: string | null) => void;
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
}

/**
 * runModelReply 工厂 + runModelReplyRef（保留 executeModelReplyCallback 命名）。
 * 该 hook 内部读取 useChatStore（addMessage / updateMessage / appendToMessage /
 * appendReasoningToMessage / removeMessage / clearLoadingForSession）。
 */
export function useChatRunModelReply(p: UseChatRunModelReplyParams): ChatRunModelReplyApi {
  const {
    addMessage,
    removeMessage,
    updateMessage,
    appendToMessage,
    appendReasoningToMessage,
    clearLoadingForSession,
  } = useChatStore();

  const executeModelReplyCallback = useCallback(
    async (sid: string, hist: Message[], user: Message, model: ModelConfig): Promise<void> => {
      const ui: RunModelReplyUi = {
        locale: p.uiLocale,
        t: p.t,
        consumeVoiceWakeReply: p.consumeVoiceWakeReply,
        setVoiceReplySpeaking: p.setVoiceReplySpeaking,
        setVectorRagStatus: p.setVectorRagStatus,
        setImageGenProgress: p.setImageGenProgress,
        setIsStreaming: p.setIsStreaming,
        setStreamingTargetAssistantId: p.setStreamingTargetAssistantId,
        setInlineImageIndex: p.setInlineImageIndex,
        inlineImageIndexRef: p.inlineImageIndexRef,
        streamingAssistantIdRef: p.streamingAssistantIdRef,
        streamingSessionIdRef: p.streamingSessionIdRef,
        streamUnsubRef: p.streamUnsubRef,
        streamHadErrorRef: p.streamHadErrorRef,
        streamCancelledByUserRef: p.streamCancelledByUserRef,
        imageGenCancelledRef: p.imageGenCancelledRef,
        imageGenSyncRef: p.imageGenSyncRef,
        speechReaderRef: p.speechReaderRef,
        addMessage,
        updateMessage,
        appendToMessage,
        appendReasoningToMessage,
        removeMessage,
        clearLoadingForSession,
      };
      await executeModelReply(ui, sid, hist, user, model);
    },
    [
      addMessage,
      appendReasoningToMessage,
      appendToMessage,
      clearLoadingForSession,
      removeMessage,
      updateMessage,
      p.t,
      p.uiLocale,
      p.consumeVoiceWakeReply,
      p.setVoiceReplySpeaking,
      p.setVectorRagStatus,
      p.setImageGenProgress,
      p.setIsStreaming,
      p.setStreamingTargetAssistantId,
      p.setInlineImageIndex,
      p.inlineImageIndexRef,
      p.streamingAssistantIdRef,
      p.streamingSessionIdRef,
      p.streamUnsubRef,
      p.streamHadErrorRef,
      p.streamCancelledByUserRef,
      p.imageGenCancelledRef,
      p.imageGenSyncRef,
      p.speechReaderRef,
    ]
  );

  const runModelReplyRef = useRef(executeModelReplyCallback);
  runModelReplyRef.current = executeModelReplyCallback;

  return {
    runModelReply: executeModelReplyCallback,
    runModelReplyRef,
  };
}