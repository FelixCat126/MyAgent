/** 手势 1D 惯性参数（预览翻页 / 列表滚动共用） */
export const GESTURE_MOMENTUM_FRICTION = 0.985;
export const GESTURE_MOMENTUM_MIN_VEL = 0.01;
export const GESTURE_MOMENTUM_SNAP = 0.32;
export const GESTURE_PALM_VEL_SMOOTH = 0.72;

/** 预览：归一化位移 → 页 */
export const GALLERY_DRAG_SENS = 6.2;
export const GALLERY_VEL_SENS = 12.5;

/** 列表滚动：归一化位移 → 像素（× 视口高） */
export const SCROLL_DRAG_VIEWPORT_GAIN = 1.05;
/** 列表滚动：归一化速度 → 像素/秒（× 视口高） */
export const SCROLL_VEL_VIEWPORT_GAIN = 9.0;

export function applyFriction(velocity: number, dt: number): number {
  return velocity * Math.pow(GESTURE_MOMENTUM_FRICTION, dt * 60);
}

export function snapToward(current: number, target: number, rate: number): number {
  const diff = target - current;
  if (Math.abs(diff) < 0.004) return target;
  return current + diff * rate;
}
