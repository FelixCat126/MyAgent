import { create } from 'zustand';

/**
 * 粒子背景的运动控制状态。
 *
 * 设计要点：
 * - 仅服务于"对话区背景粒子层"的运行时表现，**不持久化、不进 zustand persist**；
 *   关闭/重开应用应回到稳定默认值，避免上一次手势状态被"冻结"。
 * - 写入侧（GestureControl）只需 setMotion 增量更新；读取侧（ParticleField）订阅本 store。
 * - 数值范围统一：scale ∈ [0.4, 1.8]，旋转使用弧度（不取模），depthZ ∈ [-0.6, 0.6]。
 */
export interface ParticleMotion {
  /** 等比缩放。1 为基线；抓握→收缩 (<1)，张开→膨胀 (>1) */
  scale: number;
  /** 绕 X 轴旋转弧度（来源：上/下滑） */
  rotateX: number;
  /** 绕 Y 轴旋转弧度（来源：左/右滑） */
  rotateY: number;
  /** 绕 Z 轴旋转弧度（保留：后续可用握拳旋拧、双手扭转等） */
  rotateZ: number;
  /** Z 轴整体偏移：负→向相机推近（凹陷视觉），正→远离（凸起视觉） */
  depthZ: number;
}

export const PARTICLE_MOTION_DEFAULT: ParticleMotion = {
  scale: 1,
  rotateX: 0,
  rotateY: 0,
  rotateZ: 0,
  depthZ: 0,
};

/** 粒子调色板键；既可由 Agent 业务状态切换，也允许手势直接覆盖（如 ILoveYou → love、Thumb_Up → cheer）。 */
export type ParticleMood = 'idle' | 'thinking' | 'streaming' | 'error' | 'love' | 'cheer';

/** 粒子形态目标：sphere=球面（默认），heart=玫红心形 */
export type ParticleMorph = 'sphere' | 'heart';

/**
 * Agent 业务活动阶段。ParticleField 根据该阶段派生 mood/spin/呼吸表现：
 * - idle: 默认缓慢自转
 * - awake: 唤醒后待发送，呼吸式膨胀收缩
 * - thinking: 思考中，旋转
 * - replying: 流式回复中，呼吸式膨胀收缩
 */
export type AgentActivity = 'idle' | 'awake' | 'thinking' | 'replying';

interface ParticleStore {
  motion: ParticleMotion;
  mood: ParticleMood;
  /** 反相：触发后粒子调色板的 primary/accent 互换，配合手腕翻转动作 */
  invertColor: boolean;
  /** 全屏：浮窗放大至覆盖整窗，配合"双手张开极限"或 OK 长按触发 */
  fullscreen: boolean;
  /** 一次性脉冲事件版本号：每次自增，ParticleField 在渲染中根据时间戳衰减 */
  pulseTick: number;
  /** 脉冲幅度（≥0）：>1 表示瞬时膨胀，<1 表示瞬时坍缩 */
  pulseAmp: number;
  /** 脉冲触发时间（performance.now()） */
  pulseStartedAt: number;
  /** Y 轴持续旋转角速度（弧度/秒）。0=不旋转。由手势临时驱动，ParticleField 内部做平滑跟随。 */
  spinSpeed: number;
  /** 粒子形态目标。ParticleField 内部 lerp 过渡。 */
  morphTarget: ParticleMorph;
  /** 业务活动阶段；当无 gestureOverride 时驱动粒子表现。 */
  agentActivity: AgentActivity;
  /** 手势是否正在覆盖业务表现（true 时优先用 mood/spinSpeed/morphTarget；false 时由 activity 派生） */
  gestureOverride: boolean;
  /**
   * 眼动注视目标，单位向量 [-1, 1]²；由 useFaceTracking 写入：
   *   x: 负=看左，正=看右；y: 负=看上，正=看下。
   * CartoonAvatar 用其位移瞳孔；GazeIndicator 用其计算屏幕落点。
   */
  gazeTarget: { x: number; y: number };
  /** 主动触发的眨眼：0=正常，1=完全闭眼；由 useFaceTracking 写入实时值 */
  blinkAmount: number;
  /** 嘴巴张合度 0..1；replying 时由 ChatWindow 驱动张合，cheer 时由手势提至 1 */
  mouthOpen: number;
  /** 头部左右倾斜弧度；thinking 时由 CartoonAvatar 自身做摇摆动画 */
  headTilt: number;
  /**
   * 卡通形象浮窗在视口坐标系的中心点；由 FloatingParticleWindow 在位置变化时写入，
   * GazeIndicator 作为注视投射线的起点。
   */
  avatarCenter: { x: number; y: number } | null;
  /**
   * 视线原始特征：归一化后的眼动方向 (gx, gy) ∈ [-1,1]² 与头部姿态 yaw/pitch（弧度）。
   * 由 useFaceTracking 每帧写入；供 GazeCalibration 采样、GazeIndicator 应用拟合后的仿射变换。
   * 当 gestureControlEnabled=false 或检测不到人脸时为 null。
   */
  gazeRaw: { gx: number; gy: number; yaw: number; pitch: number } | null;
  /** 目光光标在屏幕上的平滑位置（像素）；GazeIndicator 写入，眨眼点击时读取 */
  gazeScreenPos: { x: number; y: number } | null;
  /** 食指指尖映射的原始屏幕坐标（像素）；useGestureControl 写入，GazeIndicator 平滑后写入 gazeScreenPos */
  pointerTarget: { x: number; y: number } | null;
  /** 右手呈食指操作姿态时为 true；单眨点击仅在此状态下触发 */
  pointerOperationActive: boolean;
  /** 增量合并 motion；缺省字段保持原值 */
  setMotion: (patch: Partial<ParticleMotion>) => void;
  /** 一次性归零所有 motion（用于"放下手势/失焦"等场景） */
  resetMotion: () => void;
  setMood: (mood: ParticleMood) => void;
  toggleInvertColor: () => void;
  setFullscreen: (v: boolean) => void;
  /** 触发一次性脉冲；amp>1=膨胀，0<amp<1=坍缩 */
  triggerPulse: (amp: number) => void;
  setSpinSpeed: (v: number) => void;
  setMorphTarget: (m: ParticleMorph) => void;
  setAgentActivity: (a: AgentActivity) => void;
  setGestureOverride: (v: boolean) => void;
  setGazeTarget: (g: { x: number; y: number }) => void;
  setBlinkAmount: (v: number) => void;
  setMouthOpen: (v: number) => void;
  setHeadTilt: (v: number) => void;
  setAvatarCenter: (p: { x: number; y: number } | null) => void;
  setGazeRaw: (g: { gx: number; gy: number; yaw: number; pitch: number } | null) => void;
  setGazeScreenPos: (p: { x: number; y: number } | null) => void;
  setPointerTarget: (p: { x: number; y: number } | null) => void;
  setPointerOperationActive: (v: boolean) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function sanitizeMotion(next: ParticleMotion): ParticleMotion {
  return {
    scale: clamp(next.scale, 0.4, 1.8),
    rotateX: clamp(next.rotateX, -Math.PI * 2, Math.PI * 2),
    rotateY: clamp(next.rotateY, -Math.PI * 2, Math.PI * 2),
    rotateZ: clamp(next.rotateZ, -Math.PI * 2, Math.PI * 2),
    depthZ: clamp(next.depthZ, -0.6, 0.6),
  };
}

export const useParticleStore = create<ParticleStore>((set) => ({
  motion: { ...PARTICLE_MOTION_DEFAULT },
  mood: 'idle',
  invertColor: false,
  fullscreen: false,
  pulseTick: 0,
  pulseAmp: 1,
  pulseStartedAt: 0,
  spinSpeed: 0,
  morphTarget: 'sphere',
  agentActivity: 'idle',
  gestureOverride: false,
  gazeTarget: { x: 0, y: 0 },
  blinkAmount: 0,
  mouthOpen: 0,
  headTilt: 0,
  avatarCenter: null,
  gazeRaw: null,
  gazeScreenPos: null,
  pointerTarget: null,
  pointerOperationActive: false,
  setMotion: (patch) =>
    set((s) => ({ motion: sanitizeMotion({ ...s.motion, ...patch }) })),
  resetMotion: () => set({ motion: { ...PARTICLE_MOTION_DEFAULT } }),
  setMood: (mood) => set({ mood }),
  toggleInvertColor: () => set((s) => ({ invertColor: !s.invertColor })),
  setFullscreen: (v) => set({ fullscreen: v }),
  triggerPulse: (amp) =>
    set((s) => ({
      pulseTick: s.pulseTick + 1,
      pulseAmp: amp,
      pulseStartedAt:
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now(),
    })),
  setSpinSpeed: (v) =>
    set({ spinSpeed: Number.isFinite(v) ? clamp(v, -40, 40) : 0 }),
  setMorphTarget: (m) => set({ morphTarget: m }),
  setAgentActivity: (a) => set({ agentActivity: a }),
  setGestureOverride: (v) => set({ gestureOverride: v }),
  setGazeTarget: (g) =>
    set({ gazeTarget: { x: clamp(g.x, -1, 1), y: clamp(g.y, -1, 1) } }),
  setBlinkAmount: (v) => set({ blinkAmount: clamp(v, 0, 1) }),
  setMouthOpen: (v) => set({ mouthOpen: clamp(v, 0, 1) }),
  setHeadTilt: (v) =>
    set({ headTilt: clamp(v, -Math.PI / 4, Math.PI / 4) }),
  setAvatarCenter: (p) => set({ avatarCenter: p }),
  setGazeRaw: (g) => set({ gazeRaw: g }),
  setGazeScreenPos: (p) => set({ gazeScreenPos: p }),
  setPointerTarget: (p) => set({ pointerTarget: p }),
  setPointerOperationActive: (v) => set({ pointerOperationActive: v }),
}));
