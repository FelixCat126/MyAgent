import { useEffect } from 'react';
import type { SessionStreamRefs } from './useChatStreamRefs';

export interface ChatLifecycleCleanupApi {
  cancelVoiceReply: () => void;
  streamRefs: SessionStreamRefs;
}

/**
 * 卸载清理：
 * - 关流（streamUnsubRef.current?.(); closeModelStream）
 * - 关语音（cancelVoiceReply）
 * - 重置 particle activity 到 idle
 * 注意：原先在 ChatWindow 内的「卸载关流 / 关语音」effect 移到这里集中处理。
 */
export function useChatLifecycleCleanup(api: ChatLifecycleCleanupApi): void {
  const { cancelVoiceReply, streamRefs } = api;

  useEffect(() => {
    return () => {
      for (const refs of streamRefs.all()) {
        refs.streamUnsubRef.current?.();
        refs.streamUnsubRef.current = null;
      }
      cancelVoiceReply();
      try {
        window.electron?.closeModelStream?.();
      } catch {
        /* ignore */
      }
    };
  }, [cancelVoiceReply, streamRefs]);
}