import { useEffect, useLayoutEffect, useRef } from 'react';

/** 距底部小于该值视为「在底部」，流式输出时可自动跟随滚动 */
export const SCROLL_STICK_BOTTOM_PX = 120;

export interface ChatScrollStickApi {
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  stickToBottomRef: React.MutableRefObject<boolean>;
}

/**
 * 自动贴底 + ResizeObserver 逻辑：
 * - 监听滚动事件同步 stickToBottomRef（距底部 < SCROLL_STICK_BOTTOM_PX 视为贴底）
 * - ResizeObserver：若处于贴底态，容器尺寸变化时自动滚到底
 * - messages / currentSessionId / showTypingDots / vectorRagStatus / footerH / attachments.length / isCompressingCurrent
 *   变化且仍贴底时，执行贴底
 * - imageGenProgress 出现时若贴底则滚到底
 * - currentSessionId 变化时强制贴底（stickToBottomRef.current = true）
 */
export function useChatScrollStick(deps: {
  currentSessionId: string | null;
  showTypingDots: boolean;
  vectorRagStatus: { text: string; tone: 'success' | 'info' | 'error' } | null;
  footerH: number;
  attachmentsLength: number;
  isCompressingCurrent: boolean;
  imageGenProgress: { current: number; total: number; messageId: string } | null;
  messages: unknown[];
}): ChatScrollStickApi {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // currentSessionId 变化时强制贴底
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [deps.currentSessionId]);

  // 生图占位出现时贴底
  useLayoutEffect(() => {
    if (!deps.imageGenProgress || !stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [deps.imageGenProgress]);

  // 监听滚动同步 stickToBottomRef
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
  }, [deps.currentSessionId]);

  // ResizeObserver：贴底时尺寸变化自动滚到底
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [deps.currentSessionId]);

  // 内容变化时贴底
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    deps.messages,
    deps.currentSessionId,
    deps.showTypingDots,
    deps.vectorRagStatus,
    deps.footerH,
    deps.attachmentsLength,
    deps.isCompressingCurrent,
  ]);

  return { scrollContainerRef, stickToBottomRef };
}