import { useEffect, useRef } from 'react';
import { useParticleStore } from '../store/particleStore';
import { OneEuroFilter } from '../utils/oneEuroFilter';
import { createVisionFileset, toModelBuffer } from '../utils/mediapipeLoader';

/**
 * 复用 useGestureControl 暴露的 <video> 元素跑 MediaPipe FaceLandmarker：
 *   - 推导注视方向 (gx, gy) ∈ [-1, 1]² 并写入 particleStore.gazeTarget
 *   - 实时眨眼幅度 blinkAmount 写入 particleStore
 *   - 检测"双眨眼"：800ms 窗口内完成两次完整闭→开 → dispatch CustomEvent('myagent-double-blink')
 *   - 检测"单眨眼"：一次完整闭→开后等待 SINGLE_BLINK_CONFIRM_MS，若无第二次眨眼 → 点击
 *
 * 设计：
 * - 不自己 getUserMedia，避免对同一摄像头并发占用；
 * - 推理频率与手势识别相同（约 18 帧 / 秒，55ms 间隔），节流的 setInterval；
 * - 模型字节流通过 IPC 获取，与 gesture_recognizer 同一通道范式；
 * - face_landmarker 输出 blendshapes 与 facialTransformationMatrixes，前者足以满足注视/眨眼。
 */
const TICK_INTERVAL_MS = 33;
const BLINK_CLOSE_THRESHOLD = 0.55;
const BLINK_OPEN_THRESHOLD = 0.35;
/** 高于此值时眼动 blendshape 不可信，冻结视线输出（避免眨眼时光标滑向底部） */
const GAZE_UPDATE_MAX_BLINK = 0.22;
/** 眨眼结束后额外冻结时长，等待 blendshape 恢复 */
const GAZE_RECOVERY_AFTER_BLINK_MS = 220;
const DOUBLE_BLINK_WINDOW_MS = 700;
const DOUBLE_BLINK_COOLDOWN_MS = 1200;
/** 单眨确认：睁眼后等待；第二次眨眼「开始闭眼」会立即取消，故可短于双眨间隔 */
const SINGLE_BLINK_CONFIRM_MS = 240;
const SINGLE_BLINK_COOLDOWN_MS = 200;
/**
 * 注视零点自适应：blendshape 的 lookUp/lookDown/lookIn/lookOut 在不同用户/摄像头位置下
 * 平视时也会有显著基线（最常见：笔记本摄像头位于屏幕上方 → eyeLookDown 长期偏高 ~0.2）。
 * 启动后用快速 α 收敛 2 秒得到初始基线，之后切换到极慢 α，保证既能消除常驻偏置，
 * 又不会让"长时间看同一方向"被基线吃掉。
 */
const BASELINE_ALPHA_FAST = 0.06;
const BASELINE_ALPHA_SLOW = 0.0015;
const BASELINE_FAST_DURATION_MS = 2000;
/** raw gaze 强度放大；blendshape 单值很少超过 0.5，乘 2.4 后落到 ±1 区间 */
const GAZE_SENSITIVITY = 2.4;
/** 闭眼瞬间的注视冻结时长（与睁眼后的 GAZE_RECOVERY_AFTER_BLINK_MS 衔接） */
const GAZE_HOLD_AFTER_BLINK_CLOSE_MS = 450;
/** 无人脸时的输出衰减系数（blink 快速归零、gaze 缓慢回中） */
const NO_FACE_BLINK_DECAY = 0.7;
const NO_FACE_GAZE_DECAY = 0.85;
/** OneEuroFilter 参数：minCutoff 越低越平滑，beta 控制速度响应 */
const EURO_MIN_CUTOFF = 1.0;
const EURO_BETA = 0.018;
const EURO_DERIVATIVE_CUTOFF = 1.0;

interface BlendshapeCategory {
  index: number;
  score: number;
  categoryName: string;
}

interface FaceLandmarkerResult {
  faceBlendshapes?: Array<{ categories: BlendshapeCategory[] }>;
  facialTransformationMatrixes?: Array<{ data: Float32Array | number[] }>;
  faceLandmarks?: Array<Array<{ x: number; y: number; z?: number }>>;
}

/**
 * 从 MediaPipe FaceLandmarker 4×4 变换矩阵提取头部 yaw/pitch（弧度）。
 * 矩阵为 column-major，旋转分量在前 3×3。
 * yaw  = 绕 Y 轴：用户向左/右转头   → atan2(-R[2][0], R[0][0])
 * pitch= 绕 X 轴：用户向上/下点头  → atan2(R[2][1], R[2][2])
 * 输出已限幅到 ±π/3，避免极端值在回归中放大误差。
 */
function extractYawPitch(mat: Float32Array | number[]): { yaw: number; pitch: number } {
  if (!mat || mat.length < 16) return { yaw: 0, pitch: 0 };
  const m20 = mat[2];
  const m00 = mat[0];
  const m21 = mat[6];
  const m22 = mat[10];
  const yawRaw = Math.atan2(-m20, m00);
  const pitchRaw = Math.atan2(m21, m22);
  const cap = Math.PI / 3;
  return {
    yaw: Math.max(-cap, Math.min(cap, yawRaw)),
    pitch: Math.max(-cap, Math.min(cap, pitchRaw)),
  };
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
  /** 仅检测眨眼（单眨点击 / 双眨设置），不写入眼动 gaze 通道 */
  blinkOnly = false,
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
    /** 注视零点（gxRaw/gyRaw 的低通基线），用于扣除常驻偏置 */
    let gxBaseline = 0;
    let gyBaseline = 0;
    /** 首次检测到人脸的时间，用于切换 baseline 收敛速度 */
    let firstDetectAt = 0;
    /** 在此时间戳之前不更新视线（覆盖眨眼过程 + 短暂恢复） */
    let gazeHoldUntil = 0;
    /** 闭眼瞬间锁定的光标位置，供单眨点击使用 */
    let blinkClickPos: { x: number; y: number } | null = null;
    const euroGx = new OneEuroFilter(EURO_MIN_CUTOFF, EURO_BETA, EURO_DERIVATIVE_CUTOFF);
    const euroGy = new OneEuroFilter(EURO_MIN_CUTOFF, EURO_BETA, EURO_DERIVATIVE_CUTOFF);
    let euroPrimed = false;

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
      st.setGazeTarget({ x: 0, y: 0 });
      st.setBlinkAmount(0);
      st.setGazeRaw(null);
      st.setGazeScreenPos(null);
    };

    /** 注视管线：blendshape 四向强度 → 基线扣除 → Euro 滤波 → 写 store */
    const updateGaze = (
      cats: BlendshapeCategory[],
      res: FaceLandmarkerResult,
      blink: number,
      now: number
    ) => {
      const lookInL = findScore(cats, 'eyeLookInLeft');
      const lookOutL = findScore(cats, 'eyeLookOutLeft');
      const lookUpL = findScore(cats, 'eyeLookUpLeft');
      const lookDownL = findScore(cats, 'eyeLookDownLeft');
      const lookInR = findScore(cats, 'eyeLookInRight');
      const lookOutR = findScore(cats, 'eyeLookOutRight');
      const lookUpR = findScore(cats, 'eyeLookUpRight');
      const lookDownR = findScore(cats, 'eyeLookDownRight');

      /**
       * 注视方向：左/右眼分别给出 in/out/up/down 四向 blendshape，0..1 强度。
       * - 左眼 lookOut → 看左（从用户角度），lookIn → 看右
       * - 右眼 lookOut → 看右，lookIn → 看左
       * 整合后取均值消抖：
       *   gxRaw =  ((lookInL - lookOutL) + (lookOutR - lookInR)) / 2
       *   注意：摄像头看到的画面通常是镜像（约定 video 不翻转），用户看右即画面里他朝向画面左边 → 镜像取负
       */
      const gxRaw = ((lookInL - lookOutL) + (lookOutR - lookInR)) / 2;
      const gyRaw = ((lookDownL - lookUpL) + (lookDownR - lookUpR)) / 2;

      const gazeOk = !blinkOnly && blink <= GAZE_UPDATE_MAX_BLINK && now >= gazeHoldUntil;
      if (!gazeOk) return;

      const alpha =
        now - firstDetectAt < BASELINE_FAST_DURATION_MS ? BASELINE_ALPHA_FAST : BASELINE_ALPHA_SLOW;
      gxBaseline += (gxRaw - gxBaseline) * alpha;
      gyBaseline += (gyRaw - gyBaseline) * alpha;

      const gxAdj = gxRaw - gxBaseline;
      const gyAdj = gyRaw - gyBaseline;
      const gxRawNorm = Math.max(-1, Math.min(1, gxAdj * GAZE_SENSITIVITY));
      const gyRawNorm = Math.max(-1, Math.min(1, gyAdj * GAZE_SENSITIVITY));
      let gx: number;
      let gy: number;
      if (!euroPrimed) {
        euroGx.reset(gxRawNorm, now);
        euroGy.reset(gyRawNorm, now);
        gx = gxRawNorm;
        gy = gyRawNorm;
        euroPrimed = true;
      } else {
        gx = euroGx.filter(gxRawNorm, now);
        gy = euroGy.filter(gyRawNorm, now);
      }

      const headMat = res.facialTransformationMatrixes?.[0]?.data;
      const { yaw, pitch } = headMat ? extractYawPitch(headMat) : { yaw: 0, pitch: 0 };

      const st = useParticleStore.getState();
      st.setGazeTarget({ x: gx, y: gy });
      st.setGazeRaw({ gx, gy, yaw, pitch });
    };

    /** 眨眼状态机：写 blinkAmount；双眨优先，单眨睁眼后短延迟确认（再闭眼取消） */
    const updateBlink = (blink: number, now: number) => {
      const st = useParticleStore.getState();
      st.setBlinkAmount(blink);

      if (blinkPhase === 'open' && blink >= BLINK_CLOSE_THRESHOLD) {
        blinkPhase = 'closing';
        gazeHoldUntil = now + GAZE_HOLD_AFTER_BLINK_CLOSE_MS;
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
        gazeHoldUntil = Math.max(gazeHoldUntil, now + GAZE_RECOVERY_AFTER_BLINK_MS);
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
      if (video.readyState < 2) return;
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
        if (!blinkOnly) {
          const g = st.gazeTarget;
          st.setGazeTarget({ x: g.x * NO_FACE_GAZE_DECAY, y: g.y * NO_FACE_GAZE_DECAY });
          st.setGazeRaw(null);
          euroPrimed = false;
        }
        return;
      }

      const now = performance.now();
      if (firstDetectAt === 0) firstDetectAt = now;

      const blinkL = findScore(cats, 'eyeBlinkLeft');
      const blinkR = findScore(cats, 'eyeBlinkRight');
      const blink = (blinkL + blinkR) / 2;

      updateGaze(cats, res, blink, now);
      updateBlink(blink, now);
    };

    const start = async () => {
      if (typeof window === 'undefined' || !window.electron?.getFaceModelData) return;
      const modelInfo = await window.electron.getFaceModelData();
      if (isStale()) return;
      if (!modelInfo.ok) {
        console.warn('[useFaceTracking] 面部模型加载失败，视线/眨眼功能不可用', modelInfo.error ?? '');
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
        /** 启用 4×4 变换矩阵 → 提取头部 yaw/pitch，与眼动一起作为校准回归的输入特征 */
        outputFacialTransformationMatrixes: true,
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

    void start();

    return () => {
      sessionRef.current += 1;
      stopAll();
    };
  }, [enabled, video, blinkOnly]);
}
