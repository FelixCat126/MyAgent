export type GestureUiPhase = 'idle' | 'settings-drawer' | 'library-drawer' | 'gallery-preview';

export type GalleryNavDirection = 'prev' | 'next';

export type GallerySwipePayload =
  | { phase: 'start'; palmX: number }
  | { phase: 'move'; palmX: number; velocityX: number }
  | { phase: 'release'; velocityX: number };

export type GestureScrollPayload =
  | { phase: 'start'; palmY: number }
  | { phase: 'move'; palmY: number; velocityY: number }
  | { phase: 'release'; velocityY: number };

let phase: GestureUiPhase = 'idle';

export function setGestureUiPhase(next: GestureUiPhase): void {
  phase = next;
}

export function getGestureUiPhase(): GestureUiPhase {
  return phase;
}

export function dispatchGalleryNav(direction: GalleryNavDirection): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('myagent-gallery-nav', { detail: { direction } }),
    );
  } catch {
    /* ignore */
  }
}

/** 预览内张掌水平滑动：连续位移 + 松手速度（供惯性翻页） */
export function dispatchGallerySwipe(payload: GallerySwipePayload): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('myagent-gallery-swipe', { detail: payload }),
    );
  } catch {
    /* ignore */
  }
}

/** 张掌上下划 → 跟手 + 惯性滚动（由 gestureScrollMomentum 消费） */
export function dispatchGestureScroll(payload: GestureScrollPayload): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('myagent-gesture-scroll', { detail: payload }),
    );
  } catch {
    /* ignore */
  }
}

/** @deprecated 使用 dispatchGestureScroll */
export function dispatchGestureWheel(deltaY: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('myagent-gesture-wheel', { detail: { deltaY } }),
    );
  } catch {
    /* ignore */
  }
}
