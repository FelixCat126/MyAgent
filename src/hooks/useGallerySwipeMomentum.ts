import { useEffect, useRef, useState } from 'react';
import type { GallerySwipePayload } from '@/utils/gestureUiContext';
import {
  applyFriction,
  GALLERY_DRAG_SENS,
  GALLERY_VEL_SENS,
  GESTURE_MOMENTUM_MIN_VEL,
  GESTURE_MOMENTUM_SNAP,
  snapToward,
} from '@/utils/gestureMomentum';

export function useGallerySwipeMomentum(slideCount: number, startIndex: number) {
  const maxIdx = Math.max(0, slideCount - 1);
  const clampPos = (p: number) => Math.max(0, Math.min(maxIdx, p));

  const [scrollPos, setScrollPos] = useState(() => clampPos(startIndex));
  const [isDragging, setIsDragging] = useState(false);
  const scrollPosRef = useRef(scrollPos);
  const velocityRef = useRef(0);
  const draggingRef = useRef(false);
  const dragOriginPalmXRef = useRef(0);
  const dragOriginScrollRef = useRef(0);
  const latestPalmXRef = useRef(0);

  useEffect(() => {
    scrollPosRef.current = clampPos(startIndex);
    setScrollPos(scrollPosRef.current);
    velocityRef.current = 0;
    draggingRef.current = false;
    setIsDragging(false);
  }, [startIndex, slideCount, maxIdx]);

  useEffect(() => {
    scrollPosRef.current = clampPos(scrollPosRef.current);
    setScrollPos(scrollPosRef.current);
  }, [slideCount, maxIdx]);

  useEffect(() => {
    const onSwipe = (e: Event) => {
      if (slideCount <= 1) return;
      const detail = (e as CustomEvent<GallerySwipePayload>).detail;
      if (!detail) return;

      if (detail.phase === 'start') {
        dragOriginPalmXRef.current = detail.palmX;
        latestPalmXRef.current = detail.palmX;
        dragOriginScrollRef.current = scrollPosRef.current;
        draggingRef.current = true;
        velocityRef.current = 0;
        setIsDragging(true);
        return;
      }

      if (detail.phase === 'move') {
        if (!draggingRef.current) {
          dragOriginPalmXRef.current = detail.palmX;
          dragOriginScrollRef.current = scrollPosRef.current;
          draggingRef.current = true;
          setIsDragging(true);
        }
        latestPalmXRef.current = detail.palmX;
        velocityRef.current = detail.velocityX * GALLERY_VEL_SENS;
        return;
      }

      if (detail.phase === 'release') {
        draggingRef.current = false;
        setIsDragging(false);
        velocityRef.current = detail.velocityX * GALLERY_VEL_SENS;
      }
    };

    window.addEventListener('myagent-gallery-swipe', onSwipe as EventListener);
    return () => window.removeEventListener('myagent-gallery-swipe', onSwipe as EventListener);
  }, [slideCount, maxIdx]);

  useEffect(() => {
    if (slideCount <= 1) return;

    let raf = 0;
    let last = performance.now();

    const applyPos = (next: number) => {
      if (Math.abs(next - scrollPosRef.current) > 0.0004) {
        scrollPosRef.current = next;
        setScrollPos(next);
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;

      if (draggingRef.current) {
        const deltaPalm = latestPalmXRef.current - dragOriginPalmXRef.current;
        applyPos(clampPos(dragOriginScrollRef.current + deltaPalm * GALLERY_DRAG_SENS));
      } else {
        let v = velocityRef.current;
        if (Math.abs(v) > GESTURE_MOMENTUM_MIN_VEL) {
          let next = scrollPosRef.current + v * dt;
          if (next < 0) {
            next = 0;
            v = 0;
          } else if (next > maxIdx) {
            next = maxIdx;
            v = 0;
          } else {
            v = applyFriction(v, dt);
          }
          velocityRef.current = v;
          applyPos(next);
        } else {
          velocityRef.current = 0;
          const target = Math.round(scrollPosRef.current);
          const snapped = snapToward(scrollPosRef.current, target, GESTURE_MOMENTUM_SNAP);
          applyPos(snapped);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [slideCount, maxIdx]);

  const setIndex = (index: number) => {
    const c = clampPos(index);
    scrollPosRef.current = c;
    velocityRef.current = 0;
    draggingRef.current = false;
    setIsDragging(false);
    setScrollPos(c);
  };

  const settledIndex = Math.round(scrollPos);

  return { scrollPos, settledIndex, setIndex, isDragging };
}
