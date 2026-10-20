/**
 * 流式状态机 ref 集群 + 同步 ref：
 * - streamUnsubRef：流式订阅句柄
 * - streamHadErrorRef：流式是否异常（避免重复 toast）
 * - streamCancelledByUserRef：用户主动停止标志
 * - streamingAssistantIdRef / streamingSessionIdRef：当前流式会话
 * - imageGenCancelledRef / imageGenSyncRef：生图同步状态
 *
 * 多个会话可同时回复，因此 ref 集合与流式界面状态都按会话 id 各存一份；
 * ChatWindow 只渲染当前会话那一份，停止某会话也只触及它自己的 ref。
 */

import { useCallback, useMemo, useRef, useState } from 'react';

export interface ChatStreamRefs {
  streamUnsubRef: React.MutableRefObject<(() => void) | null>;
  streamHadErrorRef: React.MutableRefObject<boolean>;
  streamCancelledByUserRef: React.MutableRefObject<boolean>;
  cancelAnimRef: React.MutableRefObject<(() => void) | null>;
  streamingAssistantIdRef: React.MutableRefObject<string | null>;
  streamingSessionIdRef: React.MutableRefObject<string | null>;
  imageGenCancelledRef: React.MutableRefObject<boolean>;
  imageGenSyncRef: React.MutableRefObject<{ sessionId: string; messageId: string } | null>;
}

function createChatStreamRefs(): ChatStreamRefs {
  return {
    streamUnsubRef: { current: null },
    streamHadErrorRef: { current: false },
    streamCancelledByUserRef: { current: false },
    cancelAnimRef: { current: null },
    streamingAssistantIdRef: { current: null },
    streamingSessionIdRef: { current: null },
    imageGenCancelledRef: { current: false },
    imageGenSyncRef: { current: null },
  };
}

export interface SessionStreamRefs {
  /** 取该会话的 ref 集合；首次访问时创建 */
  refsFor: (sessionId: string) => ChatStreamRefs;
  all: () => ChatStreamRefs[];
  /** 丢弃已不存在会话的 ref 集合（先中止其残留流） */
  prune: (liveSessionIds: Set<string>) => void;
}

export function useSessionStreamRefs(): SessionStreamRefs {
  const registry = useRef(new Map<string, ChatStreamRefs>());
  return useMemo(
    () => ({
      refsFor: (sessionId: string) => {
        let refs = registry.current.get(sessionId);
        if (!refs) {
          refs = createChatStreamRefs();
          registry.current.set(sessionId, refs);
        }
        return refs;
      },
      all: () => [...registry.current.values()],
      prune: (liveSessionIds: Set<string>) => {
        for (const [id, refs] of registry.current) {
          if (liveSessionIds.has(id)) continue;
          refs.streamUnsubRef.current?.();
          refs.cancelAnimRef.current?.();
          registry.current.delete(id);
        }
      },
    }),
    []
  );
}

export type ImageGenProgressState = { current: number; total: number; messageId: string };
export type VectorRagStatusState = { text: string; tone: 'success' | 'info' | 'error' };

export interface SessionRunUi {
  isStreaming: boolean;
  streamingTargetAssistantId: string | null;
  imageGenProgress: ImageGenProgressState | null;
  vectorRagStatus: VectorRagStatusState | null;
}

export const IDLE_SESSION_RUN_UI: SessionRunUi = {
  isStreaming: false,
  streamingTargetAssistantId: null,
  imageGenProgress: null,
  vectorRagStatus: null,
};

export interface SessionRunUiApi {
  runUi: Record<string, SessionRunUi>;
  patchRunUi: (sessionId: string, patch: Partial<SessionRunUi>) => void;
  clearVectorRagStatuses: () => void;
  pruneRunUi: (liveSessionIds: Set<string>) => void;
}

export function useSessionRunUi(): SessionRunUiApi {
  const [runUi, setRunUi] = useState<Record<string, SessionRunUi>>({});
  const patchRunUi = useCallback((sessionId: string, patch: Partial<SessionRunUi>) => {
    setRunUi((prev) => {
      const current = prev[sessionId] ?? IDLE_SESSION_RUN_UI;
      const keys = Object.keys(patch) as (keyof SessionRunUi)[];
      if (keys.every((key) => current[key] === patch[key])) return prev;
      return { ...prev, [sessionId]: { ...current, ...patch } };
    });
  }, []);
  const clearVectorRagStatuses = useCallback(() => {
    setRunUi((prev) => {
      if (!Object.values(prev).some((entry) => entry.vectorRagStatus)) return prev;
      const next: Record<string, SessionRunUi> = {};
      for (const [id, entry] of Object.entries(prev)) next[id] = { ...entry, vectorRagStatus: null };
      return next;
    });
  }, []);
  const pruneRunUi = useCallback((liveSessionIds: Set<string>) => {
    setRunUi((prev) => {
      const stale = Object.keys(prev).filter((id) => !liveSessionIds.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, []);
  return { runUi, patchRunUi, clearVectorRagStatuses, pruneRunUi };
}
