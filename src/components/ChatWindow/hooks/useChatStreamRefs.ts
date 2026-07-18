/**
 * 流式状态机 ref 集群 + 同步 ref：
 * - streamUnsubRef：流式订阅句柄
 * - streamHadErrorRef：流式是否异常（避免重复 toast）
 * - streamCancelledByUserRef：用户主动停止标志
 * - streamingAssistantIdRef / streamingSessionIdRef：当前流式会话
 * - imageGenCancelledRef / imageGenSyncRef：生图同步状态
 *
 * 抽离原因：ChatWindow.tsx 内 12 个 useRef 集中导致状态机分散
 * 难审计。本 hook 集中返回单一 ref 集合，组件主体只需读写。
 */

import { useRef } from 'react';

export interface ChatStreamRefs {
  streamUnsubRef: React.MutableRefObject<(() => void) | null>;
  streamHadErrorRef: React.MutableRefObject<boolean>;
  streamCancelledByUserRef: React.MutableRefObject<boolean>;
  streamingAssistantIdRef: React.MutableRefObject<string | null>;
  streamingSessionIdRef: React.MutableRefObject<string | null>;
  imageGenCancelledRef: React.MutableRefObject<boolean>;
  imageGenSyncRef: React.MutableRefObject<{ sessionId: string; messageId: string } | null>;
}

export function useChatStreamRefs(): ChatStreamRefs {
  return {
    streamUnsubRef: useRef<(() => void) | null>(null),
    streamHadErrorRef: useRef(false),
    streamCancelledByUserRef: useRef(false),
    streamingAssistantIdRef: useRef<string | null>(null),
    streamingSessionIdRef: useRef<string | null>(null),
    imageGenCancelledRef: useRef(false),
    imageGenSyncRef: useRef<{ sessionId: string; messageId: string } | null>(null),
  };
}
