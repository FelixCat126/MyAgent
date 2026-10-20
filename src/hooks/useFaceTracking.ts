import { useEffect, useRef } from 'react';
import { useParticleStore } from '../store/particleStore';
import { createVisionFileset, toModelBuffer } from '../utils/mediapipeLoader';

/**
 * 复用 useGestureControl 暴露的 <video> 元素跑 MediaPipe FaceLandmarker（仅眨眼）：
 *   - 实时眨眼幅度 blinkAmount 写入 particleStore
 *   - 检测"双眨眼"：800ms 窗口内完成两次完整闭→开 → dispatch CustomEvent('myagent-double-blink')
 *   - 检测"单眨眼"：一次完整闭→开后等待 SINGLE_BLINK_CONFIRM_MS，若无第二次眨眼 → 点击
 *
 * 设计：
 * - 不自己 getUserMedia，避免对同一摄像头并发占用；
 * - 推理频率与手势识别相同（约 18 帧 / 秒，55ms 间隔），节流的 setInterval；
 * - 模型字节流通过 IPC 获取，与 gesture_recognizer 同一通道范式；
 * - face_landmarker 只需输出 blendshapes 即可判断眨眼。
 */
const TICK_INTERVAL_MS = 33;
const BLINK_CLOSE_THRESHOLD = 0.55;
const BLINK_OPEN_THRESHOLD = 0.35;
const DOUBLE_BLINK_WINDOW_MS = 700;
const DOUBLE_BLINK_COOLDOWN_MS = 1200;
/** 单眨确认：睁眼后等待；第二次眨眼「开始闭眼」会立即取消，故可短于双眨间隔 */
const SINGLE_BLINK_CONFIRM_MS = 240;
const SINGLE_BLINK_COOLDOWN_MS = 200;
/** 无人脸时 blink 快速归零 */
const NO_FACE_BLINK_DECAY = 0.7;

interface BlendshapeCategory {
  index: number;
  score: number;
  categoryName: string;
}

interface FaceLandmarkerResult {
  faceBlendshapes?: Array<{ categories: BlendshapeCategory[] }>;
}

function findScore(cats: BlendshapeCategory[] | undefined, name: string): number {
  if (!cats) return 0;
  for (let i = 0; i < cats.length; i++) {
    if (cats[i].categoryName === name) return cats[i].score;
  }
  return 0;
}

export function useFaceTracking(
  enabled: boolean,
  video: HTMLVideoElement | null,
): void {
  const aliveRef = useRef(true);
  /** session id 防 race：模型加载完发现 enabled 已变化时丢弃结果 */
  const sessionRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !video) return;

    const sessionId = ++sessionRef.current;
    const isStale = () => sessionId !== sessionRef.current || !aliveRef.current;

    let landmarker: {
      close: () => void;
      detectForVideo: (v: HTMLVideoElement, ts: number) => FaceLandmarkerResult;
    } | null = null;
    let tickTimerId: ReturnType<typeof setInterval> | null = null;

    /** 双眨眼状态机 */
    type BlinkPhase = 'open' | 'closing';
    let blinkPhase: BlinkPhase = 'open';
    /** 已记录的"完整闭眼"时间戳序列，仅保留窗口内的 */
    let blinkTimes: number[] = [];
    let lastDoubleBlinkAt = 0;
    let lastSingleBlinkClickAt = 0;
    let pendingSingleTimer: ReturnType<typeof setTimeout> | null = null;
    /** 闭眼瞬间锁定的光标位置，供单眨点击使用 */
    let blinkClickPos: { x: number; y: number } | null = null;

    const cancelPendingSingle = () => {
      if (pendingSingleTimer != null) {
        clearTimeout(pendingSingleTimer);
        pendingSingleTimer = null;
      }
    };

    const stopAll = () => {
      cancelPendingSingle();
      if (tickTimerId != null) {
        clearInterval(tickTimerId);
        tickTimerId = null;
      }
      try {
        landmarker?.close();
      } catch {
        /* ignore */
      }
      landmarker = null;
      // 复位 store 通道，避免下次启动残留
      const st = useParticleStore.getState();
      st.setBlinkAmount(0);
      st.setGazeScreenPos(null);
    };

    /** 眨眼状态机：写 blinkAmount；双眨优先，单眨睁眼后短延迟确认（再闭眼取消） */
    const updateBlink = (blink: number, now: number) => {
      const st = useParticleStore.getState();
      st.setBlinkAmount(blink);

      if (blinkPhase === 'open' && blink >= BLINK_CLOSE_THRESHOLD) {
        blinkPhase = 'closing';
        /** 待确认的单击期间又闭眼 → 视为双眨序列，取消单击 */
        if (pendingSingleTimer != null) cancelPendingSingle();
        const snapSt = useParticleStore.getState();
        if (snapSt.pointerOperationActive && snapSt.gazeScreenPos) {
          blinkClickPos = { x: snapSt.gazeScreenPos.x, y: snapSt.gazeScreenPos.y };
        } else {
          blinkClickPos = null;
        }
      } else if (blinkPhase === 'closing' && blink <= BLINK_OPEN_THRESHOLD) {
        blinkPhase = 'open';
        blinkTimes.push(now);
        blinkTimes = blinkTimes.filter((t) => now - t <= DOUBLE_BLINK_WINDOW_MS);

        if (blinkTimes.length >= 2 && now - lastDoubleBlinkAt >= DOUBLE_BLINK_COOLDOWN_MS) {
          cancelPendingSingle();
          lastDoubleBlinkAt = now;
          blinkTimes = [];
          if (typeof window !== 'undefined') {
            try {
              window.dispatchEvent(new CustomEvent('myagent-double-blink'));
            } catch {
              /* ignore */
            }
          }
        } else if (blinkTimes.length === 1) {
          cancelPendingSingle();
          if (useParticleStore.getState().pointerOperationActive) {
            pendingSingleTimer = setTimeout(() => {
              pendingSingleTimer = null;
              if (isStale()) return;
              const clickNow = performance.now();
              if (clickNow - lastDoubleBlinkAt < DOUBLE_BLINK_COOLDOWN_MS) return;
              if (clickNow - lastSingleBlinkClickAt < SINGLE_BLINK_COOLDOWN_MS) return;
              if (!useParticleStore.getState().pointerOperationActive) return;
              lastSingleBlinkClickAt = clickNow;
              blinkTimes = [];
              if (typeof window !== 'undefined') {
                try {
                  const pos =
                    blinkClickPos ?? useParticleStore.getState().gazeScreenPos ?? undefined;
                  window.dispatchEvent(
                    new CustomEvent('myagent-gaze-click', { detail: pos ?? null }),
                  );
                } catch {
                  /* ignore */
                }
              }
            }, SINGLE_BLINK_CONFIRM_MS);
          }
        }
      }
    };

    const tick = () => {
      if (isStale() || !landmarker || !video) return;
      /** 与手势共用隐藏 video：以 videoWidth 判定是否已有帧；勿死卡 readyState>=2 */
      if (video.videoWidth < 1) return;
      let res: FaceLandmarkerResult;
      try {
        res = landmarker.detectForVideo(video, performance.now());
      } catch {
        return;
      }
      const cats = res.faceBlendshapes?.[0]?.categories;
      if (!cats || cats.length === 0) {
        const st = useParticleStore.getState();
        st.setBlinkAmount(st.blinkAmount * NO_FACE_BLINK_DECAY);
        return;
      }

      const blinkL = findScore(cats, 'eyeBlinkLeft');
      const blinkR = findScore(cats, 'eyeBlinkRight');
      updateBlink((blinkL + blinkR) / 2, performance.now());
    };

    const start = async () => {
      if (typeof window === 'undefined' || !window.electron?.getFaceModelData) return;
      const modelInfo = await window.electron.getFaceModelData();
      if (isStale()) return;
      if (!modelInfo.ok) {
        console.warn('[useFaceTracking] 面部模型加载失败，眨眼功能不可用', modelInfo.error ?? '');
        return;
      }

      const modelBuffer = toModelBuffer(modelInfo.data);

      const { visionMod, fileset } = await createVisionFileset();
      if (isStale()) return;
      const fl = await visionMod.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: modelBuffer },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      if (isStale()) {
        try {
          fl.close();
        } catch {
          /* ignore */
        }
        return;
      }
      landmarker = fl as unknown as {
        close: () => void;
        detectForVideo: (v: HTMLVideoElement, ts: number) => FaceLandmarkerResult;
      };
      tickTimerId = setInterval(tick, TICK_INTERVAL_MS);
    };

    start().catch((error: unknown) => {
      if (!isStale()) console.warn('[useFaceTracking] 面部模型初始化失败，眨眼功能不可用', error);
    });

    return () => {
      sessionRef.current += 1;
      stopAll();
    };
  }, [enabled, video]);
}
