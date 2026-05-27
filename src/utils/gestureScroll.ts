import { getGestureUiPhase } from './gestureUiContext';

function isScrollable(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 2;
}

function pickSettingsScrollTarget(drawer: HTMLElement): HTMLElement | null {
  const designated = drawer.querySelector('[data-gesture-scroll-target="settings"]');
  if (!(designated instanceof HTMLElement)) return null;
  if (isScrollable(designated)) return designated;

  /** 展开配置块后真正可滚动的往往是内层 overflow 容器 */
  let best: HTMLElement = designated;
  let bestOverflow = designated.scrollHeight - designated.clientHeight;
  drawer.querySelectorAll('*').forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    const oy = getComputedStyle(node).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') return;
    const overflow = node.scrollHeight - node.clientHeight;
    if (overflow > 2 && overflow > bestOverflow) {
      bestOverflow = overflow;
      best = node;
    }
  });
  return best;
}

/** 按当前 UI 层解析应滚动的容器：设置 > 图库 > 聊天；预览模式不滚动 */
export function findGestureScrollTarget(): HTMLElement | null {
  if (getGestureUiPhase() === 'gallery-preview') return null;

  const phase = getGestureUiPhase();
  const settingsDrawer = document.querySelector('[data-gesture-drawer="settings"]');
  const settingsOpen =
    phase === 'settings-drawer' ||
    (settingsDrawer instanceof HTMLElement &&
      settingsDrawer.dataset.gestureDrawerOpen === 'true');

  if (settingsOpen && settingsDrawer instanceof HTMLElement) {
    return pickSettingsScrollTarget(settingsDrawer);
  }

  if (phase === 'library-drawer') {
    const libraryScroll = document.querySelector('[data-gesture-scroll-target="library"]');
    if (libraryScroll instanceof HTMLElement) return libraryScroll;
  }

  const chatScroll = document.querySelector('[data-gesture-scroll-target="chat"]');
  if (chatScroll instanceof HTMLElement && isScrollable(chatScroll)) {
    return chatScroll;
  }

  return null;
}

/** 向目标容器派发原生 wheel 事件，手感与鼠标滚轮一致；必要时回退 scrollTop */
export function applyGestureScroll(deltaY: number): boolean {
  if (typeof window === 'undefined' || !Number.isFinite(deltaY) || Math.abs(deltaY) < 0.25) {
    return false;
  }

  const target = findGestureScrollTarget();
  if (!target) return false;

  const before = target.scrollTop;
  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width * 0.5;
  const clientY = rect.top + rect.height * 0.45;

  target.dispatchEvent(
    new WheelEvent('wheel', {
      deltaY,
      deltaX: 0,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      bubbles: true,
      cancelable: true,
    }),
  );

  if (Math.abs(target.scrollTop - before) < 0.5) {
    target.scrollTop += deltaY;
  }

  return true;
}
