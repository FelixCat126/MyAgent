import React, { useEffect, useRef } from 'react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import {
  PARTICLE_MOTION_DEFAULT,
  useParticleStore,
  type ParticleMood,
  type ParticleMorph,
  type ParticleMotion,
  type AgentActivity,
} from '../store/particleStore';

/**
 * 业务活动 → 派生表现：mood / spin / 是否呼吸 / 形态。
 * 手势激活时（gestureOverride=true）由 store 中 mood/spinSpeed/morphTarget 接管，不经此处。
 */
interface DerivedFromActivity {
  mood: ParticleMood;
  spinSpeed: number;
  morph: ParticleMorph;
  breathing: boolean;
}

function deriveFromActivity(a: AgentActivity): DerivedFromActivity {
  switch (a) {
    case 'awake':
      return { mood: 'idle', spinSpeed: 0, morph: 'sphere', breathing: true };
    case 'thinking':
      return { mood: 'thinking', spinSpeed: 2.4, morph: 'sphere', breathing: false };
    case 'replying':
      return { mood: 'streaming', spinSpeed: 0, morph: 'sphere', breathing: true };
    case 'idle':
    default:
      return { mood: 'idle', spinSpeed: IDLE_SPIN_SPEED, morph: 'sphere', breathing: false };
  }
}

/**
 * 对话区背景粒子层（Canvas 2D）。
 *
 * 渲染思路：
 * - 在单位球面上以费马（黄金角）螺旋点法分布 N 个粒子，分布比 random 更均匀；
 * - 每帧根据 useParticleStore.motion 应用 X/Y/Z 轴旋转 → 等比缩放 → Z 偏移 → 透视投影；
 * - 即使无外部 motion，也按时间相位给每颗粒子叠加一个微小自由抖动，避免静默；
 * - motion 在组件内做 lerp 平滑，避免手势写入造成跳变；
 * - 颜色由 mood 控制；亮/暗主题分别选择高对比色板；
 * - 全程 `pointer-events: none`，不影响消息气泡交互；DPR 自适应。
 */
/** 168×168 浮窗下球面半径约 45px，原 620 颗显得拥挤；降至 360 与背景留出呼吸感 */
const PARTICLE_COUNT = 360;
const FOCAL = 520;
const BASE_RADIUS = 220;
const MOTION_LERP = 0.085;
/** 无业务指令时的缓慢自转（弧度/秒） */
const IDLE_SPIN_SPEED = 0.32;
/** 单颗粒子绘制半径系数（相对透视缩放） */
const DOT_RADIUS_MUL = 1.05;
const DOT_RADIUS_MIN = 0.32;

interface SeedPoint {
  /** 球面上的基础方向（单位向量），用于自由漂浮的相位扰动 */
  ux: number;
  uy: number;
  uz: number;
  /** 心形目标位置（XY 平面填充 + Z 厚度），单位接近 [-1, 1] */
  hx: number;
  hy: number;
  hz: number;
  /** 自由漂浮的相位、频率、幅度（每颗略不同，整体不齐步） */
  phase: number;
  freq: number;
  amp: number;
  /** 粒子基线半径权重（让靠近赤道的稍亮一些） */
  brightness: number;
}

interface MoodPalette {
  /** 主色：用于粒子核心填充 */
  primary: [number, number, number];
  /** 辅色：用于粒子外晕渐变端 */
  accent: [number, number, number];
}

/**
 * 浅色调色板：浮窗背景已与对话区同色（米灰 #d6d3cc）。
 * 'source-over' 合成模式下颜色直接覆盖，色相要够辨识，但饱和度需克制——
 * 否则在米灰底上深饱和色会形成"高对比刺眼"观感。
 * 这里整体走中明度 + 中低饱和度，色相参考暗色版同 mood 的方向。
 */
const MOOD_PALETTE_LIGHT: Record<ParticleMood, MoodPalette> = {
  idle: { primary: [85, 115, 145], accent: [60, 90, 120] },
  thinking: { primary: [120, 100, 170], accent: [95, 75, 145] },
  streaming: { primary: [195, 115, 70], accent: [165, 90, 50] },
  error: { primary: [175, 75, 85], accent: [140, 55, 65] },
  love: { primary: [180, 110, 145], accent: [155, 85, 120] },
  cheer: { primary: [190, 85, 130], accent: [165, 65, 110] },
};

const MOOD_PALETTE_DARK: Record<ParticleMood, MoodPalette> = {
  idle: { primary: [165, 220, 240], accent: [125, 185, 220] },
  thinking: { primary: [200, 180, 255], accent: [165, 140, 235] },
  streaming: { primary: [255, 200, 145], accent: [240, 160, 100] },
  error: { primary: [255, 140, 140], accent: [220, 100, 100] },
  love: { primary: [255, 180, 210], accent: [240, 130, 180] },
  cheer: { primary: [255, 110, 175], accent: [240, 70, 145] },
};

/** 费马螺旋点法在单位球面上生成 N 个近似等距点；同时为每颗预计算心形目标位置 */
function buildSeeds(count: number): SeedPoint[] {
  const seeds: SeedPoint[] = new Array(count);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  // 心形参数方程 y 范围约 [-17, 5]，统一缩放因子让心形 fit 在 [-1, 1]
  const HEART_SCALE = 17;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const ux = Math.cos(theta) * r;
    const uy = y;
    const uz = Math.sin(theta) * r;

    /**
     * 心形目标位置：
     * - 用球面经度 phi 决定心形轮廓上的角度
     * - 用 cos(纬度) 作为半径填充因子（赤道 = 心形外缘，极点 = 心形中心）
     * - z 厚度：远离赤道时凸起，形成 3D 心
     */
    const phi = Math.atan2(uz, ux);
    const fillR = Math.abs(Math.cos(Math.asin(uy)));
    const sx = Math.sin(phi);
    const heartXRaw = 16 * sx * sx * sx;
    const heartYRaw = -(
      13 * Math.cos(phi) -
      5 * Math.cos(2 * phi) -
      2 * Math.cos(3 * phi) -
      Math.cos(4 * phi)
    );
    const hx = (heartXRaw / HEART_SCALE) * fillR;
    const hy = (heartYRaw / HEART_SCALE) * fillR;
    const hz = Math.sign(uy) * (1 - fillR) * 0.45;

    seeds[i] = {
      ux,
      uy,
      uz,
      hx,
      hy,
      hz,
      phase: (i * 0.137) % (Math.PI * 2),
      freq: 0.35 + ((i * 13) % 100) / 280,
      amp: 0.012 + ((i * 7) % 100) / 6200,
      brightness: Math.abs(uy) < 0.4 ? 0.85 : 0.6,
    };
  }
  return seeds;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface ParticleFieldProps {
  className?: string;
  /** 输入栏等小尺寸容器：减少粒子数，避免拥挤与耗电 */
  compact?: boolean;
}

const ParticleField: React.FC<ParticleFieldProps> = ({ className, compact = false }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const seedsRef = useRef<SeedPoint[]>([]);
  const rafRef = useRef<number | null>(null);
  /** 平滑后的当前 motion；store 写入后通过 lerp 缓慢跟上，避免跳变 */
  const currentMotionRef = useRef<ParticleMotion>({ ...PARTICLE_MOTION_DEFAULT });
  /** spin 平滑：跟随 store.spinSpeed，避免突变停转造成跳变 */
  const spinSpeedRef = useRef<number>(0);
  const spinAngleRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);
  /** 形态过渡因子：0=球面，1=心形；lerp 跟随 effective morphTarget */
  const morphFactorRef = useRef<number>(0);
  /** 呼吸活跃度：0=不呼吸，1=完全呼吸；lerp 让 awake/replying 过渡平滑 */
  const breathingActivenessRef = useRef<number>(0);
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  const resolvedTheme = useResolvedTheme();
  const themeRef = useRef<'light' | 'dark'>(resolvedTheme);

  useEffect(() => {
    themeRef.current = resolvedTheme;
  }, [resolvedTheme]);

  const particleCount = compact ? 120 : PARTICLE_COUNT;

  /** 初始化粒子种子（compact 切换时重建） */
  if (seedsRef.current.length !== particleCount) {
    seedsRef.current = buildSeeds(particleCount);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const applySize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(2, Math.floor(rect.width));
      const h = Math.max(2, Math.floor(rect.height));
      if (sizeRef.current.w === w && sizeRef.current.h === h && sizeRef.current.dpr === dpr) {
        return;
      }
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

    const t0 = performance.now();
    let active = true;

    const pauseLoop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const startLoop = () => {
      if (!active || document.hidden || rafRef.current != null) return;
      /** 暂停后恢复：避免 dt 过大导致旋转/动画跳变 */
      lastTickRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      if (document.hidden) pauseLoop();
      else startLoop();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const tick = (now: number) => {
      rafRef.current = null;
      if (!active || document.hidden) return;
      const { w, h } = sizeRef.current;
      if (w <= 0 || h <= 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const seconds = (now - t0) / 1000;
      const stState = useParticleStore.getState();
      const targetMotion = stState.motion;
      const invertColor = stState.invertColor;

      // 计算 effective 表现：手势激活 → 直接用 store 中手势写入的 mood/spin/morph；否则由 activity 派生
      const derived = deriveFromActivity(stState.agentActivity);
      const effMood: ParticleMood = stState.gestureOverride ? stState.mood : derived.mood;
      const effSpinSpeed = stState.gestureOverride ? stState.spinSpeed : derived.spinSpeed;
      const effMorphTarget: ParticleMorph = stState.gestureOverride
        ? stState.morphTarget
        : derived.morph;
      const effBreathing = stState.gestureOverride ? false : derived.breathing;
      const gestureActive = stState.gestureOverride;
      const motionLerp = gestureActive ? 0.14 : MOTION_LERP;
      const spinLerp = gestureActive ? 0.16 : 0.08;
      const morphLerp = gestureActive ? 0.2 : 0.07;

      const mood = effMood;
      const cur = currentMotionRef.current;
      cur.scale = lerp(cur.scale, targetMotion.scale, motionLerp);
      cur.rotateX = lerp(cur.rotateX, targetMotion.rotateX, motionLerp);
      cur.rotateY = lerp(cur.rotateY, targetMotion.rotateY, motionLerp);
      cur.rotateZ = lerp(cur.rotateZ, targetMotion.rotateZ, motionLerp);
      cur.depthZ = lerp(cur.depthZ, targetMotion.depthZ, motionLerp);

      // 平滑 spin：手势/业务切换时加快跟随，减少竖大拇指等反馈的迟滞感
      spinSpeedRef.current = lerp(spinSpeedRef.current, effSpinSpeed, spinLerp);
      const dtSec = lastTickRef.current > 0 ? (now - lastTickRef.current) / 1000 : 0;
      lastTickRef.current = now;
      if (Math.abs(spinSpeedRef.current) > 0.001 || Math.abs(spinAngleRef.current) > 0.0001) {
        spinAngleRef.current = (spinAngleRef.current + dtSec * spinSpeedRef.current) % (Math.PI * 2);
      }

      // 形态因子：sphere(0) ↔ heart(1) 平滑切换
      const morphTargetVal = effMorphTarget === 'heart' ? 1 : 0;
      morphFactorRef.current = lerp(morphFactorRef.current, morphTargetVal, morphLerp);
      const morph = morphFactorRef.current;

      // 呼吸活跃度过渡 + 呼吸缩放倍率（独立于 motion.scale，不污染手势缩放）
      breathingActivenessRef.current = lerp(
        breathingActivenessRef.current,
        effBreathing ? 1 : 0,
        0.05,
      );
      // 周期约 3 秒，幅度 ±13%，叠加在 baseR 上
      const breathingMul =
        1 + Math.sin((seconds * Math.PI * 2) / 3) * 0.13 * breathingActivenessRef.current;

      // 一次性脉冲：以触发时刻 + 360ms 半衰曲线叠加在 scale 上，不污染 store.motion
      let pulseMul = 1;
      if (stState.pulseStartedAt > 0) {
        const dt = now - stState.pulseStartedAt;
        if (dt < 600) {
          const k = Math.exp(-dt / 180);
          pulseMul = 1 + (stState.pulseAmp - 1) * k;
        }
      }

      /**
       * 心形态(morph→1)时把旋转角度按 (1-morph) 衰减，使心形正对观察者，
       * 不污染 store.motion / spinAngleRef；过渡时旋转随形变同步淡出。
       */
      const morphRest = 1 - morph;
      const effRotateX = cur.rotateX * morphRest;
      const effRotateY = (cur.rotateY + spinAngleRef.current) * morphRest;
      const effRotateZ = cur.rotateZ * morphRest;
      const cosX = Math.cos(effRotateX);
      const sinX = Math.sin(effRotateX);
      const cosY = Math.cos(effRotateY);
      const sinY = Math.sin(effRotateY);
      const cosZ = Math.cos(effRotateZ);
      const sinZ = Math.sin(effRotateZ);

      const cx = w / 2;
      const cy = h / 2;
      /**
       * 基线半径系数 K：让 max(scale)·max(pulse) 仍能完整落在浮窗内。
       *  scale ∈ [0.4, 1.8]，pulse 峰值约 1.85（exp 衰减 600ms）
       *  → 极端态 K·1.8·1.85 ≈ K·3.33。透视额外膨胀约 1.2×（z=0 时 persp=1.0，
       *    z>0 半球粒子 persp 可达 ~1.4，但同时 |x|/|y| 已被球面收窄）。
       *  取 K=0.27：常态半径 ≈ 27% 窗口、最大 scale ≈ 49%、含 pulse 峰值 ≈ 90%。
       *  小于 0.5 即可保证不出框；老版 0.42 在 228 浮窗中会导致掌心拍掌时溢出。
       */
      const baseR = Math.min(w, h) * 0.27 * cur.scale * pulseMul * breathingMul;
      const focal = FOCAL + cur.depthZ * 240;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = themeRef.current === 'dark' ? 'lighter' : 'source-over';

      const palette =
        themeRef.current === 'dark' ? MOOD_PALETTE_DARK[mood] : MOOD_PALETTE_LIGHT[mood];
      // 反相：primary/accent 互换 → 主辅色调换，造成"色板翻转"观感
      const [pr, pg, pb] = invertColor ? palette.accent : palette.primary;
      const [ar, ag, ab] = invertColor ? palette.primary : palette.accent;

      const seeds = seedsRef.current;
      const oneMinusMorph = 1 - morph;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        // 球面态：原 wob 微抖动；心形态：锁定到心形目标位置（保持心形静止清晰）
        const wob = Math.sin(seconds * s.freq + s.phase) * s.amp * oneMinusMorph;
        const sphX = s.ux + s.uy * wob;
        const sphY = s.uy + s.uz * wob;
        const sphZ = s.uz + s.ux * wob;
        let x = sphX * oneMinusMorph + s.hx * morph;
        let y = sphY * oneMinusMorph + s.hy * morph;
        let z = sphZ * oneMinusMorph + s.hz * morph;

        let x1 = x;
        let y1 = y * cosX - z * sinX;
        let z1 = y * sinX + z * cosX;

        let x2 = x1 * cosY + z1 * sinY;
        let y2 = y1;
        let z2 = -x1 * sinY + z1 * cosY;

        let x3 = x2 * cosZ - y2 * sinZ;
        let y3 = x2 * sinZ + y2 * cosZ;
        let z3 = z2;

        x3 *= BASE_RADIUS;
        y3 *= BASE_RADIUS;
        z3 *= BASE_RADIUS;

        const denom = focal - z3;
        if (denom <= 1) continue;
        const persp = focal / denom;
        const px = cx + (x3 * persp * baseR) / BASE_RADIUS;
        const py = cy + (y3 * persp * baseR) / BASE_RADIUS;

        const radius = Math.max(DOT_RADIUS_MIN, DOT_RADIUS_MUL * persp * (0.7 + cur.scale * 0.3));
        /**
         * 浅色用 'source-over' 直接覆盖，过高 alpha 会形成"硬色块"刺眼感；
         * 暗色用 'lighter' 叠加发光，alpha 高才有亮度。所以两套上限各取所需。
         */
        const alphaCoef = themeRef.current === 'dark' ? 0.85 : 0.62;
        const alphaCap = themeRef.current === 'dark' ? 0.92 : 0.72;
        const alpha = Math.max(0.06, Math.min(alphaCap, persp * alphaCoef * s.brightness));

        const useAccent = (i & 7) === 0;
        const r8 = useAccent ? ar : pr;
        const g8 = useAccent ? ag : pg;
        const b8 = useAccent ? ab : pb;

        ctx.beginPath();
        ctx.fillStyle = `rgba(${r8}, ${g8}, ${b8}, ${alpha.toFixed(3)})`;
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    if (!document.hidden) startLoop();

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      pauseLoop();
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      aria-hidden
      style={{ pointerEvents: 'none' }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
};

export default ParticleField;
