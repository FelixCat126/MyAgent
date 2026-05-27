import React, { useEffect, useRef, useState } from 'react';
import { useParticleStore } from '../store/particleStore';
import { OneEuroFilter } from '../utils/oneEuroFilter';

/**
 * 食指驱动的屏幕光标：
 *  - z-index 高于图片预览/抽屉/弹窗
 *  - 1€ Filter 平滑；主窗口聚焦时同步虚拟指针 hover
 */
interface GazeIndicatorProps {
  visible: boolean;
  windowFocused: boolean;
  themeMode: 'light' | 'dark';
}

const VIEWPORT_MARGIN = 12;
const RING_RADIUS = 7;
const HOVER_SYNC_MIN_MS = 32;
const HOVER_SYNC_MIN_DIST = 3;

function clampInViewport(x: number, y: number, w: number, h: number, m: number): { x: number; y: number } {
  return {
    x: Math.max(m, Math.min(w - m, x)),
    y: Math.max(m, Math.min(h - m, y)),
  };
}

const GazeIndicator: React.FC<GazeIndicatorProps> = ({ visible, windowFocused, themeMode }) => {
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 0,
    h: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const filterXRef = useRef(new OneEuroFilter(0.14, 0.006, 0.65));
  const filterYRef = useRef(new OneEuroFilter(0.14, 0.006, 0.65));
  const primedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastHoverSyncRef = useRef({ x: 0, y: 0, t: 0 });

  const syncPointerHover = (x: number, y: number) => {
    if (!windowFocused) return;
    if (typeof window === 'undefined' || !window.electron?.simulateGazeMove) return;
    const now = performance.now();
    const last = lastHoverSyncRef.current;
    const dist = Math.hypot(x - last.x, y - last.y);
    if (now - last.t < HOVER_SYNC_MIN_MS && dist < HOVER_SYNC_MIN_DIST) return;
    lastHoverSyncRef.current = { x, y, t: now };
    void window.electron.simulateGazeMove(x, y);
  };

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!visible) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      primedRef.current = false;
      setPos(null);
      useParticleStore.getState().setGazeScreenPos(null);
      return;
    }
    primedRef.current = false;
    let running = true;

    const tick = (frameNow: number) => {
      rafRef.current = null;
      if (!running) return;

      const st = useParticleStore.getState();
      if (!st.pointerOperationActive || !st.pointerTarget) {
        setPos(null);
        useParticleStore.getState().setGazeScreenPos(null);
        primedRef.current = false;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const target = st.pointerTarget;
      const now = frameNow;

      let smoothX: number;
      let smoothY: number;
      if (!primedRef.current) {
        filterXRef.current.reset(target.x, now);
        filterYRef.current.reset(target.y, now);
        smoothX = target.x;
        smoothY = target.y;
        primedRef.current = true;
      } else {
        smoothX = filterXRef.current.filter(target.x, now);
        smoothY = filterYRef.current.filter(target.y, now);
      }

      const clamped = clampInViewport(smoothX, smoothY, viewport.w, viewport.h, VIEWPORT_MARGIN);
      setPos(clamped);
      useParticleStore.getState().setGazeScreenPos(clamped);
      syncPointerHover(clamped.x, clamped.y);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      useParticleStore.getState().setGazeScreenPos(null);
    };
  }, [visible, windowFocused, viewport.w, viewport.h]);

  if (!visible || !pos) return null;

  const dark = themeMode === 'dark';
  const ringColor = dark ? 'rgba(120,220,255,0.8)' : 'rgba(8,145,178,0.75)';
  const dotColor = dark ? 'rgba(200,245,255,0.95)' : 'rgba(8,145,178,0.95)';

  return (
    <svg
      className="pointer-events-none fixed inset-0 z-[10020]"
      width={viewport.w}
      height={viewport.h}
      style={{ left: 0, top: 0 }}
      aria-hidden
    >
      <circle
        cx={pos.x}
        cy={pos.y}
        r={RING_RADIUS}
        fill="none"
        stroke={ringColor}
        strokeWidth={1.2}
        strokeDasharray="4 3"
      />
      <circle cx={pos.x} cy={pos.y} r={1.8} fill={dotColor} />
    </svg>
  );
};

export default GazeIndicator;
