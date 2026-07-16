import { useEffect } from 'react';

export interface ChatLifecycleCleanupApi {
  cancelVoiceReply: () => void;
  streamUnsubRef: React.MutableRefObject<(() => void) | null>;
}

/**
 * 卸载清理：
 * - 关流（streamUnsubRef.current?.(); closeModelStream）
 * - 关语音（cancelVoiceReply）
 * - 重置 particle activity 到 idle
 * 注意：原先在 ChatWindow 内的「卸载关流 / 关语音」effect 移到这里集中处理。
 */
export function useChatLifecycleCleanup(api: ChatLifecycleCleanupApi): void {
  const { cancelVoiceReply, streamUnsubRef } = api;

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
  }, [cancelVoiceReply, streamUnsubRef]);
}