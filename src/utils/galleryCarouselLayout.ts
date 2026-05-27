/** 3D 走马灯单卡布局（abs 为相对中心的整数层） */
export function galleryCardLayout(abs: number): {
  x: number;
  rotateY: number;
  z: number;
  scale: number;
  opacity: number;
} {
  if (abs < 1e-4) {
    return { x: 0, rotateY: 0, z: 0, scale: 1, opacity: 1 };
  }
  const STEPS = [240, 130, 80];
  let stepSum = 0;
  for (let i = 1; i <= abs && i <= STEPS.length; i++) {
    stepSum += STEPS[i - 1]!;
  }
  const rotateAbs = abs === 1 ? 45 : abs === 2 ? 58 : 65;
  const z = -abs * 110;
  const scale = abs === 1 ? 0.78 : abs === 2 ? 0.62 : 0.5;
  const opacity = abs === 1 ? 0.4 : abs === 2 ? 0.22 : 0.12;
  return { x: stepSum, rotateY: rotateAbs, z, scale, opacity };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 支持小数 offset，用于跟手 / 惯性滑动 */
export function galleryCarouselCardMetricsSmooth(fractionalOffset: number): {
  transform: string;
  opacity: number;
  zIndex: number;
  pointerEvents: 'auto' | 'none';
} {
  if (Math.abs(fractionalOffset) < 1e-4) {
    return {
      transform: 'translate(-50%, -50%) translateZ(0) rotateY(0deg) scale(1)',
      opacity: 1,
      zIndex: 50,
      pointerEvents: 'auto',
    };
  }

  const sign = fractionalOffset < 0 ? -1 : 1;
  const abs = Math.abs(fractionalOffset);
  const i0 = Math.floor(abs);
  const i1 = Math.min(3, i0 + 1);
  const t = i1 === i0 ? 0 : abs - i0;

  const a = galleryCardLayout(i0);
  const b = galleryCardLayout(i1);
  const x = sign * lerp(a.x, b.x, t);
  const rotateY = -sign * lerp(a.rotateY, b.rotateY, t);
  const z = lerp(a.z, b.z, t);
  const scale = lerp(a.scale, b.scale, t);
  const opacity = lerp(a.opacity, b.opacity, t);
  const absRounded = Math.round(abs);

  return {
    transform: `translate(calc(-50% + ${x}px), -50%) translateZ(${z}px) rotateY(${rotateY}deg) scale(${scale})`,
    opacity,
    zIndex: 40 - absRounded,
    pointerEvents: absRounded === 1 ? 'auto' : 'none',
  };
}
