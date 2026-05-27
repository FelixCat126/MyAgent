import { useEffect, useRef, useState } from 'react';
import { useParticleStore, type ParticleMood } from '../store/particleStore';
import { useSettingStore } from '../store/settingStore';
import {
  dispatchGallerySwipe,
  dispatchGestureScroll,
  getGestureUiPhase,
} from '@/utils/gestureUiContext';
import { GESTURE_PALM_VEL_SMOOTH } from '@/utils/gestureMomentum';

/**
 * 摄像头 + MediaPipe GestureRecognizer：
 * - 握拳↔张掌：开关图库
 * - 剪刀手 ✌️（Victory / 食+中伸）：图库内进入预览 / 预览内退出
 * - 张掌上下移动：跟手 + 惯性滚动（预览模式除外）
 * - 预览内张掌水平滑动：跟手 + 松手惯性翻页
 * - 单独食指：指尖在画面中位置映射全屏光标
 */

const RING_TIP = 16;
const RING_PIP = 14;
const PINKY_TIP = 20;
const PINKY_PIP = 18;

interface UseGestureControlResult {
  cameraActive: boolean;
  status: GestureStatus;
  videoElement: HTMLVideoElement | null;
}

export type GestureStatus =
  | { kind: 'idle' }
  | { kind: 'loading-model' }
  | { kind: 'requesting-camera' }
  | { kind: 'ready' }
  | { kind: 'model-missing' }
  | { kind: 'permission-denied'; message?: string }
  | { kind: 'error'; message: string };

const TARGET_FRAME_INTERVAL_MS = 16;
const PALM_LANDMARK_INDEX = 9;
const INDEX_TIP = 8;
const INDEX_PIP = 6;
const MIDDLE_TIP = 12;
const MIDDLE_PIP = 10;
const WRIST = 0;
/** 操作姿态内短暂丢失 landmark 时仍保持目标，避免跟手抖；离开操作姿态立即清 */
const POINTER_HOLD_MS = 120;
const SCALE_DECAY = 0.06;
const ROTATE_DECAY = 0.10;
const DEPTH_DECAY = 0.08;
const GESTURE_TRANSITION_MIN_HOLD_MS = 320;
const LIBRARY_TRANSITION_COOLDOWN_MS = 900;
const PREVIEW_GESTURE_COOLDOWN_MS = 450;
/** 剪刀手需持续保持才触发预览进/出，避免张掌过渡误触 */
const PREVIEW_VICTORY_HOLD_MS = 480;
/** 图库刚打开后一段时间内禁止进入预览 */
const LIBRARY_PREVIEW_GUARD_MS = 1400;
/** 张掌预览滑动：速度跟踪（越大越跟手） */
const SWIPE_VEL_SMOOTH = GESTURE_PALM_VEL_SMOOTH;
const PALM_SCROLL_HOLD_MS = 120;

type HandLandmark = { x: number; y: number; z?: number };

function lmDist(a: HandLandmark, b: HandLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isIndexExtended(lm: HandLandmark[]): boolean {
  return isFingerExtended(lm, INDEX_TIP, INDEX_PIP);
}

function isFingerExtended(lm: HandLandmark[], tip: number, pip: number): boolean {
  if (lm.length <= tip) return false;
  return lmDist(lm[tip], lm[WRIST]) > lmDist(lm[pip], lm[WRIST]) * 1.08;
}

function isMiddleExtended(lm: HandLandmark[]): boolean {
  return isFingerExtended(lm, MIDDLE_TIP, MIDDLE_PIP);
}

function isRingExtended(lm: HandLandmark[]): boolean {
  return isFingerExtended(lm, RING_TIP, RING_PIP);
}

function isPinkyExtended(lm: HandLandmark[]): boolean {
  return isFingerExtended(lm, PINKY_TIP, PINKY_PIP);
}

/** 张掌：四指均明显伸出（阈值略严，避免 V 手势误判为张掌） */
function isOpenPalmPose(lm: HandLandmark[]): boolean {
  if (lm.length <= PINKY_TIP) return false;
  const midR = lmDist(lm[MIDDLE_TIP], lm[WRIST]);
  if (midR < 1e-4) return false;
  return (
    isIndexExtended(lm) &&
    isMiddleExtended(lm) &&
    lmDist(lm[RING_TIP], lm[WRIST]) > midR * 0.95 &&
    lmDist(lm[PINKY_TIP], lm[WRIST]) > midR * 0.95
  );
}

/**
 * 严格剪刀手：食+中伸、无名/小指明显收起；张掌过渡帧不满足。
 */
function isStrictVictoryPose(lm: HandLandmark[]): boolean {
  if (!isIndexExtended(lm) || !isMiddleExtended(lm)) return false;
  if (isOpenPalmPose(lm)) return false;
  if (isRingExtended(lm) || isPinkyExtended(lm)) return false;
  const midR = lmDist(lm[MIDDLE_TIP], lm[WRIST]);
  if (midR < 1e-4) return false;
  const ringR = lmDist(lm[RING_TIP], lm[WRIST]);
  const pinkyR = lmDist(lm[PINKY_TIP], lm[WRIST]);
  return ringR < midR * 0.88 && pinkyR < midR * 0.88;
}

/** 预览进/出：必须 Victory 分类 + 严格 landmark，且当前非张掌 */
function isVictoryPreviewGesture(rawGesture: string, gestureName: string, lm: HandLandmark[]): boolean {
  if (rawGesture === 'Open_Palm' || gestureName === 'Open_Palm') return false;
  if (isOpenPalmPose(lm) || isPalmScrollActive(rawGesture, gestureName, lm)) return false;
  const classifiedVictory = rawGesture === 'Victory' || gestureName === 'Victory';
  if (!classifiedVictory) return false;
  return isStrictVictoryPose(lm);
}

function isPalmScrollActive(rawGesture: string, gestureName: string, lm: HandLandmark[]): boolean {
  if (rawGesture === 'Closed_Fist' || gestureName === 'Closed_Fist') return false;
  if (rawGesture !== 'Open_Palm' && gestureName !== 'Open_Palm') return false;
  return (
    isIndexExtended(lm) &&
    isMiddleExtended(lm) &&
    isRingExtended(lm) &&
    isPinkyExtended(lm)
  );
}

function clampToViewport(x: number, y: number): { x: number; y: number } {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const margin = 12;
  return {
    x: Math.max(margin, Math.min(w - margin, x)),
    y: Math.max(margin, Math.min(h - margin, y)),
  };
}

/** 单独食指：指尖在画面中的绝对位置映射全屏（镜像 X） */
function mapIndexTipToScreen(lm: HandLandmark[]): { x: number; y: number } {
  const tip = lm[INDEX_TIP];
  const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
  return clampToViewport((1 - tip.x) * w, tip.y * h);
}

/** 握拳分类但食指仍伸出 → 当作食指，避免掌→食过渡误关图库 */
function effectiveGestureName(name: string, lm: HandLandmark[]): string {
  if (name === 'Closed_Fist' && isIndexExtended(lm)) return 'Pointing_Up';
  return name;
}

function isPointerMode(gestureName: string, lm: HandLandmark[]): boolean {
  if (!isIndexExtended(lm)) return false;
  if (isStrictVictoryPose(lm) || gestureName === 'Victory') return false;
  if (gestureName === 'Open_Palm' || gestureName === 'Thumb_Up') return false;
  if (isMiddleExtended(lm)) return false;
  return true;
}

export function useGestureControl(enabled: boolean): UseGestureControlResult {
  const [cameraActive, setCameraActive] = useState(false);
  const [status, setStatus] = useState<GestureStatus>({ kind: 'idle' });
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);

  const aliveRef = useRef(true);
  const gestureSessionRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus({ kind: 'idle' });
      setCameraActive(false);
      return;
    }

    const sessionId = ++gestureSessionRef.current;
    const isStale = () => sessionId !== gestureSessionRef.current || !aliveRef.current;

    let videoEl: HTMLVideoElement | null = null;
    let stream: MediaStream | null = null;
    let recognizer: { close: () => void; recognizeForVideo: (v: HTMLVideoElement, ts: number) => GestureResult } | null = null;
    let tickTimerId: number | null = null;
    let lastGestureTickAt = 0;

    /** 图库开合链：仅跟踪 Open_Palm ↔ Closed_Fist */
    let lastLibraryGesture = '';
    let lastLibraryGestureSince = 0;
    const lastActionAt: Record<string, number> = {};

    let prevWasVictoryPreview = false;
    let victoryHoldSince = 0;
    let victoryPreviewFired = false;
    let lastLibraryOpenAt = 0;
    let lastSwipePalmX: number | null = null;
    let lastSwipePalmT = 0;
    let swipeVelX = 0;
    let swipeSessionActive = false;
    let scrollSessionActive = false;
    let lastPalmScrollAt = 0;
    let lastScrollPalmY: number | null = null;
    let lastScrollPalmT = 0;
    let scrollVelY = 0;
    let cheerActive = false;
    let cheerPrevMood: ParticleMood = 'idle';
    let lastPointerPos: { x: number; y: number } | null = null;
    let lastPointerAt = 0;

    const palmStore = useParticleStore;

    const updatePointerTarget = (pos: { x: number; y: number } | null, now: number) => {
      if (pos) {
        lastPointerPos = pos;
        lastPointerAt = now;
        palmStore.getState().setPointerTarget(pos);
        return;
      }
      if (lastPointerPos && now - lastPointerAt < POINTER_HOLD_MS) {
        palmStore.getState().setPointerTarget(lastPointerPos);
        return;
      }
      lastPointerPos = null;
      palmStore.getState().setPointerTarget(null);
    };

    const dispatchGestureAction = (kind: string, cooldownMs: number): boolean => {
      const t = performance.now();
      const prev = lastActionAt[kind] ?? 0;
      if (t - prev < cooldownMs) return false;
      lastActionAt[kind] = t;
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('myagent-gesture-action', { detail: { kind } }));
        } catch {
          /* ignore */
        }
      }
      return true;
    };

    const resetPreviewGestureEdges = () => {
      prevWasVictoryPreview = false;
      victoryHoldSince = 0;
      victoryPreviewFired = false;
    };

    const resetPalmScroll = () => {
      if (scrollSessionActive) {
        dispatchGestureScroll({ phase: 'release', velocityY: scrollVelY });
      }
      scrollSessionActive = false;
      lastPalmScrollAt = 0;
      lastScrollPalmY = null;
      lastScrollPalmT = 0;
      scrollVelY = 0;
    };

    const resetSwipe = () => {
      if (swipeSessionActive) {
        dispatchGallerySwipe({ phase: 'release', velocityX: swipeVelX });
      }
      lastSwipePalmX = null;
      lastSwipePalmT = 0;
      swipeVelX = 0;
      swipeSessionActive = false;
    };

    const stopCheer = () => {
      if (!cheerActive) return;
      cheerActive = false;
      const st = palmStore.getState();
      st.setGestureOverride(false);
      if (st.mood === 'cheer') st.setMood(cheerPrevMood);
      st.setMorphTarget('sphere');
    };

    const tryCheer = (gestureName: string) => {
      const isThumbUp = gestureName === 'Thumb_Up';
      if (isThumbUp && !cheerActive) {
        cheerActive = true;
        const st = palmStore.getState();
        cheerPrevMood = st.mood;
        st.setMood('cheer');
        st.setMorphTarget('heart');
        st.setSpinSpeed(0);
        st.setGestureOverride(true);
      } else if (!isThumbUp && cheerActive) {
        stopCheer();
      }
    };

    const tryLibraryTransition = (gestureName: string, now: number) => {
      if (getGestureUiPhase() === 'settings-drawer') return;
      if (gestureName !== 'Closed_Fist' && gestureName !== 'Open_Palm') return;
      if (gestureName === lastLibraryGesture) return;

      const prev = lastLibraryGesture;
      const heldMs = now - lastLibraryGestureSince;
      const phase = getGestureUiPhase();
      if (prev && heldMs >= GESTURE_TRANSITION_MIN_HOLD_MS) {
        if (prev === 'Closed_Fist' && gestureName === 'Open_Palm') {
          if (phase === 'idle') {
            if (dispatchGestureAction('open-image-library', LIBRARY_TRANSITION_COOLDOWN_MS)) {
              lastLibraryOpenAt = now;
            }
          }
        } else if (prev === 'Open_Palm' && gestureName === 'Closed_Fist') {
          if (phase !== 'idle') {
            dispatchGestureAction('close-image-library', LIBRARY_TRANSITION_COOLDOWN_MS);
          }
        }
      }
      lastLibraryGesture = gestureName;
      lastLibraryGestureSince = now;
    };

    const tryPreviewGestures = (
      rawGesture: string,
      gestureName: string,
      landmarks: HandLandmark[],
      now: number,
    ) => {
      const phase = getGestureUiPhase();
      const victory = isVictoryPreviewGesture(rawGesture, gestureName, landmarks);

      if (!victory) {
        victoryHoldSince = 0;
        victoryPreviewFired = false;
        prevWasVictoryPreview = false;
        return;
      }

      if (victoryHoldSince === 0) victoryHoldSince = now;
      if (victoryPreviewFired) return;
      if (now - victoryHoldSince < PREVIEW_VICTORY_HOLD_MS) return;

      if (phase === 'library-drawer' && now - lastLibraryOpenAt < LIBRARY_PREVIEW_GUARD_MS) return;

      if (!prevWasVictoryPreview) {
        if (phase === 'library-drawer') {
          if (dispatchGestureAction('enter-gallery-preview', PREVIEW_GESTURE_COOLDOWN_MS)) {
            victoryPreviewFired = true;
          }
        } else if (phase === 'gallery-preview') {
          if (dispatchGestureAction('exit-gallery-preview', PREVIEW_GESTURE_COOLDOWN_MS)) {
            victoryPreviewFired = true;
          }
        }
      }
      prevWasVictoryPreview = true;
    };

    const tryPalmScroll = (
      landmarks: HandLandmark[],
      rawGesture: string,
      gestureName: string,
      now: number,
    ) => {
      if (getGestureUiPhase() === 'gallery-preview') {
        resetPalmScroll();
        return;
      }

      const active = isPalmScrollActive(rawGesture, gestureName, landmarks);
      if (!active) {
        if (lastPalmScrollAt > 0 && now - lastPalmScrollAt < PALM_SCROLL_HOLD_MS) return;
        resetPalmScroll();
        return;
      }
      lastPalmScrollAt = now;

      const palmY = landmarks[PALM_LANDMARK_INDEX].y;

      if (!scrollSessionActive) {
        lastScrollPalmY = palmY;
        lastScrollPalmT = now;
        scrollVelY = 0;
        scrollSessionActive = true;
        dispatchGestureScroll({ phase: 'start', palmY });
        return;
      }

      const dt = Math.max(0.001, (now - lastScrollPalmT) / 1000);
      const dy = palmY - (lastScrollPalmY ?? palmY);
      const instantVy = dy / dt;
      scrollVelY = instantVy * SWIPE_VEL_SMOOTH + scrollVelY * (1 - SWIPE_VEL_SMOOTH);

      dispatchGestureScroll({
        phase: 'move',
        palmY,
        velocityY: scrollVelY,
      });

      lastScrollPalmY = palmY;
      lastScrollPalmT = now;
    };

    const tryGallerySwipe = (palmX: number, gestureName: string, now: number) => {
      if (getGestureUiPhase() !== 'gallery-preview') {
        resetSwipe();
        return;
      }
      if (gestureName !== 'Open_Palm') {
        resetSwipe();
        return;
      }

      if (!swipeSessionActive) {
        lastSwipePalmX = palmX;
        lastSwipePalmT = now;
        swipeVelX = 0;
        swipeSessionActive = true;
        dispatchGallerySwipe({ phase: 'start', palmX });
        return;
      }

      const dt = Math.max(0.001, (now - lastSwipePalmT) / 1000);
      const dx = palmX - (lastSwipePalmX ?? palmX);
      const instantVx = dx / dt;
      swipeVelX = instantVx * SWIPE_VEL_SMOOTH + swipeVelX * (1 - SWIPE_VEL_SMOOTH);

      dispatchGallerySwipe({
        phase: 'move',
        palmX,
        velocityX: swipeVelX,
      });

      lastSwipePalmX = palmX;
      lastSwipePalmT = now;
    };

    const stopAll = () => {
      if (tickTimerId != null) {
        cancelAnimationFrame(tickTimerId);
        tickTimerId = null;
      }
      try {
        recognizer?.close();
      } catch {
        /* ignore */
      }
      recognizer = null;
      if (stream) {
        for (const tr of stream.getTracks()) {
          try {
            tr.stop();
          } catch {
            /* ignore */
          }
        }
        stream = null;
      }
      if (videoEl?.parentNode) {
        try {
          videoEl.parentNode.removeChild(videoEl);
        } catch {
          /* ignore */
        }
      }
      videoEl = null;
      setVideoElement(null);
      setCameraActive(false);
      palmStore.getState().resetMotion();
      lastPointerPos = null;
      lastPointerAt = 0;
      palmStore.getState().setPointerTarget(null);
      palmStore.getState().setPointerOperationActive(false);
      lastLibraryGesture = '';
      lastLibraryGestureSince = 0;
      resetPreviewGestureEdges();
      resetSwipe();
      resetPalmScroll();
      stopCheer();
    };

    const applyDecay = () => {
      const st = palmStore.getState();
      const m = st.motion;
      st.setMotion({
        scale: m.scale + (1 - m.scale) * SCALE_DECAY,
        rotateX: m.rotateX * (1 - ROTATE_DECAY),
        rotateY: m.rotateY * (1 - ROTATE_DECAY),
        rotateZ: m.rotateZ * (1 - ROTATE_DECAY),
        depthZ: m.depthZ * (1 - DEPTH_DECAY),
      });
      lastLibraryGesture = '';
      lastLibraryGestureSince = performance.now();
      resetPreviewGestureEdges();
      resetSwipe();
      resetPalmScroll();
      stopCheer();
      lastPointerPos = null;
      lastPointerAt = 0;
      st.setPointerTarget(null);
      st.setPointerOperationActive(false);
    };

    const applyResult = (result: GestureResult | null, now: number) => {
      const st = palmStore.getState();
      const m = st.motion;
      let nextScale = m.scale + (1 - m.scale) * SCALE_DECAY;

      const handsList = result?.handedness ?? result?.handednesses ?? [];
      let handIdx = -1;
      for (let i = 0; i < handsList.length; i++) {
        if (handsList[i]?.[0]?.categoryName === 'Right') {
          handIdx = i;
          break;
        }
      }
      /** 仅识别右手；左手或未识别到右手时整帧忽略，不 fallback 到第一只手 */
      const landmarks = handIdx >= 0 ? result?.landmarks?.[handIdx] : undefined;
      const rawGesture =
        handIdx >= 0 ? result?.gestures?.[handIdx]?.[0]?.categoryName ?? '' : '';

      if (!landmarks || landmarks.length < 21) {
        st.setMotion({
          scale: nextScale,
          rotateX: m.rotateX * (1 - ROTATE_DECAY),
          rotateY: m.rotateY * (1 - ROTATE_DECAY),
          rotateZ: m.rotateZ * (1 - ROTATE_DECAY),
          depthZ: m.depthZ * (1 - DEPTH_DECAY),
        });
        if (useSettingStore.getState().gestureControlEnabled) {
          lastLibraryGesture = '';
          lastLibraryGestureSince = now;
          resetPreviewGestureEdges();
          resetSwipe();
          resetPalmScroll();
          stopCheer();
          lastPointerPos = null;
          lastPointerAt = 0;
          palmStore.getState().setPointerTarget(null);
          palmStore.getState().setPointerOperationActive(false);
        }
        return;
      }

      const gestureName = effectiveGestureName(rawGesture, landmarks);
      const gestureEnabled = useSettingStore.getState().gestureControlEnabled;

      if (gestureEnabled) {
        tryLibraryTransition(gestureName, now);
        tryPreviewGestures(rawGesture, gestureName, landmarks, now);
        tryPalmScroll(landmarks, rawGesture, gestureName, now);
        tryGallerySwipe(landmarks[PALM_LANDMARK_INDEX].x, gestureName, now);
        tryCheer(gestureName);

        const pointerActive = isPointerMode(gestureName, landmarks);
        palmStore.getState().setPointerOperationActive(pointerActive);

        if (pointerActive) {
          updatePointerTarget(mapIndexTipToScreen(landmarks), now);
        } else {
          lastPointerPos = null;
          lastPointerAt = 0;
          palmStore.getState().setPointerTarget(null);
        }

        if (rawGesture === 'Closed_Fist') {
          nextScale = nextScale + (0.55 - nextScale) * 0.18;
        } else if (rawGesture === 'Open_Palm') {
          nextScale = nextScale + (1.55 - nextScale) * 0.18;
        }
      }

      st.setMotion({
        scale: nextScale,
        rotateX: m.rotateX * (1 - ROTATE_DECAY),
        rotateY: m.rotateY * (1 - ROTATE_DECAY),
        rotateZ: m.rotateZ * (1 - ROTATE_DECAY),
        depthZ: m.depthZ * (1 - DEPTH_DECAY),
      });
    };

    const start = async () => {
      try {
        setStatus({ kind: 'loading-model' });
        if (typeof window === 'undefined' || !window.electron?.getGestureModelData) {
          setStatus({ kind: 'model-missing' });
          return;
        }
        const modelInfo = await window.electron.getGestureModelData();
        if (isStale()) return;
        if (!modelInfo.ok) {
          setStatus({ kind: 'model-missing' });
          return;
        }
        const raw = modelInfo.data as unknown;
        const modelBuffer: Uint8Array =
          raw instanceof Uint8Array
            ? raw
            : raw && typeof raw === 'object' && 'buffer' in (raw as { buffer?: ArrayBuffer })
              ? new Uint8Array((raw as { buffer: ArrayBuffer }).buffer)
              : new Uint8Array(raw as ArrayBuffer);

        const wasmBaseUrl = new URL('./mediapipe-wasm/', window.location.href).href;
        const visionMod = await import('@mediapipe/tasks-vision');
        if (isStale()) return;
        const fileset = await visionMod.FilesetResolver.forVisionTasks(wasmBaseUrl);
        if (isStale()) return;
        const gr = await visionMod.GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: modelBuffer },
          runningMode: 'VIDEO',
          numHands: 2,
        });
        if (isStale()) {
          try {
            gr.close();
          } catch {
            /* ignore */
          }
          return;
        }
        recognizer = gr as unknown as {
          close: () => void;
          recognizeForVideo: (v: HTMLVideoElement, ts: number) => GestureResult;
        };

        setStatus({ kind: 'requesting-camera' });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 360, frameRate: { ideal: 18, max: 24 } },
          audio: false,
        });
        if (isStale()) {
          stopAll();
          return;
        }

        videoEl = document.createElement('video');
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.style.position = 'fixed';
        videoEl.style.width = '1px';
        videoEl.style.height = '1px';
        videoEl.style.opacity = '0';
        videoEl.style.pointerEvents = 'none';
        videoEl.style.left = '-9999px';
        videoEl.srcObject = stream;
        document.body.appendChild(videoEl);

        await videoEl.play().catch(() => {});

        if (isStale()) {
          stopAll();
          return;
        }

        setStatus({ kind: 'ready' });
        setCameraActive(true);
        setVideoElement(videoEl);

        const tick = (now: number) => {
          tickTimerId = requestAnimationFrame(tick);
          if (isStale()) {
            stopAll();
            return;
          }
          if (now - lastGestureTickAt < TARGET_FRAME_INTERVAL_MS) return;
          lastGestureTickAt = now;
          const v = videoEl;
          if (!v || v.readyState < 2 || !recognizer) {
            applyDecay();
            return;
          }
          try {
            applyResult(recognizer.recognizeForVideo(v, now), now);
          } catch {
            applyDecay();
          }
        };

        lastGestureTickAt = 0;
        tickTimerId = requestAnimationFrame(tick);
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
          setStatus({ kind: 'permission-denied', message: err.message });
        } else {
          setStatus({ kind: 'error', message: err?.message || String(e) });
        }
        stopAll();
      }
    };

    void start();

    return () => {
      gestureSessionRef.current += 1;
      stopAll();
      setStatus({ kind: 'idle' });
    };
  }, [enabled]);

  return { cameraActive, status, videoElement };
}

interface GestureCategory {
  categoryName: string;
  score: number;
}

interface GestureResult {
  landmarks: Array<Array<{ x: number; y: number; z?: number }>>;
  gestures: GestureCategory[][];
  handedness?: GestureCategory[][];
  handednesses?: GestureCategory[][];
}
