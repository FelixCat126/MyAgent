import { findGestureScrollTarget } from './gestureScroll';
import type { GestureScrollPayload } from './gestureUiContext';
import {
  applyFriction,
  GESTURE_MOMENTUM_MIN_VEL,
  SCROLL_DRAG_VIEWPORT_GAIN,
  SCROLL_VEL_VIEWPORT_GAIN,
} from './gestureMomentum';

type ScrollEngine = {
  target: HTMLElement | null;
  dragging: boolean;
  scrollPos: number;
  velocity: number;
  dragOriginPalmY: number;
  dragOriginScroll: number;
  latestPalmY: number;
};

let engine: ScrollEngine = {
  target: null,
  dragging: false,
  scrollPos: 0,
  velocity: 0,
  dragOriginPalmY: 0,
  dragOriginScroll: 0,
  latestPalmY: 0,
};

let rafId = 0;
let listeners = 0;
let lastTickAt = 0;

function viewportH(): number {
  return typeof window !== 'undefined' ? window.innerHeight : 1080;
}

function dragSensPx(): number {
  return viewportH() * SCROLL_DRAG_VIEWPORT_GAIN;
}

function velSensPx(): number {
  return viewportH() * SCROLL_VEL_VIEWPORT_GAIN;
}

function maxScroll(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

function clampScroll(pos: number, max: number): number {
  return Math.max(0, Math.min(max, pos));
}

function adoptTarget(el: HTMLElement | null): void {
  if (el === engine.target) return;
  engine.target = el;
  engine.dragging = false;
  engine.velocity = 0;
  engine.dragOriginPalmY = 0;
  engine.dragOriginScroll = 0;
  engine.latestPalmY = 0;
  if (el) engine.scrollPos = el.scrollTop;
}

function resolveTarget(): HTMLElement | null {
  adoptTarget(findGestureScrollTarget());
  return engine.target;
}

function applyDomScroll(el: HTMLElement, pos: number): void {
  const max = maxScroll(el);
  const next = clampScroll(pos, max);
  if (Math.abs(el.scrollTop - next) > 0.25) {
    el.scrollTop = next;
  }
  engine.scrollPos = next;
}

function onGestureScroll(e: Event): void {
  const detail = (e as CustomEvent<GestureScrollPayload>).detail;
  if (!detail) return;

  const el = resolveTarget();
  if (!el) return;

  if (detail.phase === 'start') {
    engine.dragging = true;
    engine.dragOriginPalmY = detail.palmY;
    engine.dragOriginScroll = el.scrollTop;
    engine.latestPalmY = detail.palmY;
    engine.velocity = 0;
    engine.scrollPos = el.scrollTop;
    return;
  }

  if (detail.phase === 'move') {
    if (!engine.dragging) {
      engine.dragging = true;
      engine.dragOriginPalmY = detail.palmY;
      engine.dragOriginScroll = el.scrollTop;
    }
    engine.latestPalmY = detail.palmY;
    engine.velocity = detail.velocityY * velSensPx();
    const deltaPalm = detail.palmY - engine.dragOriginPalmY;
    engine.scrollPos = clampScroll(
      engine.dragOriginScroll + deltaPalm * dragSensPx(),
      maxScroll(el),
    );
    applyDomScroll(el, engine.scrollPos);
    return;
  }

  if (detail.phase === 'release') {
    engine.dragging = false;
    engine.velocity = detail.velocityY * velSensPx();
  }
}

function tick(now: number): void {
  rafId = requestAnimationFrame(tick);
  const dt = Math.min(0.032, lastTickAt > 0 ? (now - lastTickAt) / 1000 : 0.016);
  lastTickAt = now;

  const el = resolveTarget();
  if (!el) {
    engine.velocity = 0;
    engine.dragging = false;
    return;
  }

  if (engine.dragging) {
    const deltaPalm = engine.latestPalmY - engine.dragOriginPalmY;
    engine.scrollPos = clampScroll(
      engine.dragOriginScroll + deltaPalm * dragSensPx(),
      maxScroll(el),
    );
    applyDomScroll(el, engine.scrollPos);
    return;
  }

  let v = engine.velocity;
  const stopThreshold = GESTURE_MOMENTUM_MIN_VEL * velSensPx() * 0.08;
  if (Math.abs(v) <= stopThreshold) {
    engine.velocity = 0;
    return;
  }

  let next = engine.scrollPos + v * dt;
  const max = maxScroll(el);
  if (next < 0) {
    next = 0;
    v = 0;
  } else if (next > max) {
    next = max;
    v = 0;
  } else {
    v = applyFriction(v, dt);
  }

  engine.scrollPos = next;
  engine.velocity = v;
  applyDomScroll(el, next);
}

/** 安装张掌滚动惯性引擎（App 挂载一次） */
export function installGestureScrollMomentum(): () => void {
  listeners += 1;
  if (listeners === 1) {
    window.addEventListener('myagent-gesture-scroll', onGestureScroll as EventListener);
    lastTickAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  return () => {
    listeners = Math.max(0, listeners - 1);
    if (listeners === 0) {
      window.removeEventListener('myagent-gesture-scroll', onGestureScroll as EventListener);
      cancelAnimationFrame(rafId);
      lastTickAt = 0;
      engine = {
        target: null,
        dragging: false,
        scrollPos: 0,
        velocity: 0,
        dragOriginPalmY: 0,
        dragOriginScroll: 0,
        latestPalmY: 0,
      };
    }
  };
}
