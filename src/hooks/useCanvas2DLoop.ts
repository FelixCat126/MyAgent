import { useEffect, useRef } from 'react';

/** 线性插值（canvas 动画共用） */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export type CanvasLoopSize = { w: number; h: number; dpr: number };

/**
 * Canvas 2D 渲染循环共享骨架：DPR 自适应尺寸、ResizeObserver、
 * 页面隐藏时暂停 rAF、卸载清理。CartoonAvatar 与 ParticleField 曾各持一份。
 */
export function useCanvas2DLoop(opts: {
  /** DPR 上限：头像 2（细腻）、粒子场 1.5（省电） */
  dprCap: number;
  onTick: (ctx: CanvasRenderingContext2D, now: number, size: CanvasLoopSize) => void;
  /** 页面从隐藏恢复时回调（如重置 dt 基准防跳变） */
  onResume?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef<CanvasLoopSize>({ w: 0, h: 0, dpr: 1 });
  const onTickRef = useRef(opts.onTick);
  onTickRef.current = opts.onTick;
  const onResumeRef = useRef(opts.onResume);
  onResumeRef.current = opts.onResume;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const applySize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(opts.dprCap, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(2, Math.floor(rect.width));
      const h = Math.max(2, Math.floor(rect.height));
      if (sizeRef.current.w === w && sizeRef.current.h === h && sizeRef.current.dpr === dpr) return;
      sizeRef.current = { w, h, dpr };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);

    let running = true;
    const tick = (now: number) => {
      rafRef.current = null;
      if (!running || document.hidden) return;
      onTickRef.current(ctx, now, sizeRef.current);
      if (running && !document.hidden) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const onVisibility = () => {
      if (document.hidden) {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      } else if (rafRef.current == null && running) {
        onResumeRef.current?.();
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
    };
  }, [opts.dprCap]);

  return { canvasRef, containerRef, sizeRef };
}
