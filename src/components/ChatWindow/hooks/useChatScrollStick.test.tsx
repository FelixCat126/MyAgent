import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatScrollStick } from './useChatScrollStick';

const baseDeps = {
  showTypingDots: false,
  vectorRagStatus: null,
  footerH: 72,
  attachmentsLength: 0,
  isCompressingCurrent: false,
  imageGenProgress: null,
  messages: [],
};

describe('useChatScrollStick', () => {
  it('shows a return button away from the bottom and smoothly returns to the latest message', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChatScrollStick({ ...baseDeps, currentSessionId: sessionId }),
      { initialProps: { sessionId: 'session-1' } },
    );

    const container = document.createElement('div');
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      container.scrollTop = Number(top ?? 0);
    });
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });
    (result.current.scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current =
      container;

    // Trigger the session-scoped listener after mounting the synthetic scroll container.
    rerender({ sessionId: 'session-2' });

    act(() => {
      container.scrollTop = 260;
      container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.showScrollToLatest).toBe(true);
    expect(result.current.stickToBottomRef.current).toBe(false);

    act(() => result.current.scrollToLatest());
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
    expect(result.current.showScrollToLatest).toBe(false);
    expect(result.current.stickToBottomRef.current).toBe(true);
  });
});
