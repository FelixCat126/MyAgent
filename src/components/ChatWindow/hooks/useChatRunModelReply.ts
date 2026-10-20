import { useCallback, useRef } from 'react';
import { runModelReply as executeModelReply, type RunModelReplyUi } from '../../../chat/runModelReply';
import { useChatStore } from '../../../store/chatStore';
import type { Message, ModelConfig } from '../../../types';
import type { Locale } from '../../../i18n/types';
import type { StreamingSpeechReader } from '../../../utils/streamingSpeech';
import type { SessionRunUi, SessionStreamRefs } from './useChatStreamRefs';

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
  /** 流式界面状态按会话写入；每次回复只改自己会话那一份 */
  patchRunUi: (sessionId: string, patch: Partial<SessionRunUi>) => void;
  streamRefs: SessionStreamRefs;
  setInlineImageIndex: React.Dispatch<React.SetStateAction<number>>;
  inlineImageIndexRef: React.MutableRefObject<number>;
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
      const refs = p.streamRefs.refsFor(sid);
      const ui: RunModelReplyUi = {
        locale: p.uiLocale,
        t: p.t,
        consumeVoiceWakeReply: p.consumeVoiceWakeReply,
        setVoiceReplySpeaking: p.setVoiceReplySpeaking,
        setVectorRagStatus: (vectorRagStatus) => p.patchRunUi(sid, { vectorRagStatus }),
        setImageGenProgress: (imageGenProgress) => p.patchRunUi(sid, { imageGenProgress }),
        setIsStreaming: (isStreaming) => p.patchRunUi(sid, { isStreaming }),
        setStreamingTargetAssistantId: (streamingTargetAssistantId) =>
          p.patchRunUi(sid, { streamingTargetAssistantId }),
        setInlineImageIndex: p.setInlineImageIndex,
        inlineImageIndexRef: p.inlineImageIndexRef,
        ...refs,
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
      p.patchRunUi,
      p.streamRefs,
      p.setInlineImageIndex,
      p.inlineImageIndexRef,
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