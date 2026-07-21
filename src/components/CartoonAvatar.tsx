import React, { useEffect, useRef } from 'react';
import { useParticleStore, ParticleMood, AgentActivity } from '../store/particleStore';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { useCanvas2DLoop, lerp } from '../hooks/useCanvas2DLoop';

/**
 * 粒子点阵女性面孔渲染（赛博 / 全息风）。
 *
 * 视觉设计：
 *  - 用参数化曲线在 [-1,1]² 归一化坐标系里采出 ~250 个粒子点；
 *  - 每帧给每个粒子加一个微抖动（基于 phase 的 sin/cos，幅度 ≈ 0.6 px）；
 *  - 同组（脸轮廓 / 头发 / 眉 / 上下眼睑 / 鼻 / 上下唇）相邻粒子之间绘制
 *    淡薄的连线，形成"网格描边"的科技感；
 *  - 双层粒子：内核（亮）+ 外晕（径向梯度 sprite，按 颜色+半径 缓存，避免每帧数百个梯度对象）；
 *  - 眼睛除眼眶外，单独绘制实心瞳孔，跟随 gazeTarget 在眼眶内位移；
 *  - 眨眼时上眼睑 morph 到下眼睑中线；
 *  - 嘴唇按 mouthOpen 张合；
 *  - 整体随 motion.scale 缩放、随 headTilt 旋转。
 *
 * 与外部接口：
 *  - 仅消费 useParticleStore：mood / agentActivity / motion.scale / gazeTarget /
 *    blinkAmount / mouthOpen / headTilt；
 *  - 不依赖 props 颜色，按主题切换两套调色板；
 *  - 组件名保留 CartoonAvatar，FloatingParticleWindow 引用无需改动。
 */
interface CartoonAvatarProps {
  className?: string;
}

interface Palette {
  /** 粒子主色（核心点的填充） */
  primary: string;
  /** 粒子辅色（外晕、二次粒子） */
  accent: string;
  /** 网格连线颜色 */
  mesh: string;
  /** 瞳孔色 */
  pupil: string;
  /** 嘴唇主色 */
  lip: string;
  /** 眉毛主色 */
  brow: string;
}

const PALETTE_DARK: Record<ParticleMood, Palette> = {
  idle: { primary: '#5fe8ff', accent: '#b794f6', mesh: 'rgba(95,232,255,0.22)', pupil: '#ffffff', lip: '#ff9bd0', brow: '#d6b8ff' },
  thinking: { primary: '#a78bfa', accent: '#7dd3fc', mesh: 'rgba(167,139,250,0.22)', pupil: '#f5f3ff', lip: '#f0abfc', brow: '#c4b5fd' },
  streaming: { primary: '#facc15', accent: '#fb923c', mesh: 'rgba(250,204,21,0.22)', pupil: '#fff7c2', lip: '#fb7185', brow: '#fbbf24' },
  error: { primary: '#fb7185', accent: '#f43f5e', mesh: 'rgba(251,113,133,0.25)', pupil: '#fff1f2', lip: '#e11d48', brow: '#fda4af' },
  love: { primary: '#f472b6', accent: '#a78bfa', mesh: 'rgba(244,114,182,0.22)', pupil: '#fdf2f8', lip: '#ec4899', brow: '#f9a8d4' },
  cheer: { primary: '#ff7ac6', accent: '#7dd3fc', mesh: 'rgba(255,122,198,0.25)', pupil: '#fff1f2', lip: '#f472b6', brow: '#ff9bd0' },
};

const PALETTE_LIGHT: Record<ParticleMood, Palette> = {
  idle: { primary: '#0891b2', accent: '#7c3aed', mesh: 'rgba(8,145,178,0.32)', pupil: '#0c4a6e', lip: '#be185d', brow: '#6d28d9' },
  thinking: { primary: '#7c3aed', accent: '#0891b2', mesh: 'rgba(124,58,237,0.32)', pupil: '#1e1b4b', lip: '#a21caf', brow: '#6d28d9' },
  streaming: { primary: '#b45309', accent: '#dc2626', mesh: 'rgba(180,83,9,0.32)', pupil: '#451a03', lip: '#9d174d', brow: '#92400e' },
  error: { primary: '#b91c1c', accent: '#7c2d12', mesh: 'rgba(185,28,28,0.32)', pupil: '#450a0a', lip: '#9f1239', brow: '#991b1b' },
  love: { primary: '#be185d', accent: '#7c3aed', mesh: 'rgba(190,24,93,0.32)', pupil: '#500724', lip: '#a21caf', brow: '#9d174d' },
  cheer: { primary: '#c026d3', accent: '#0891b2', mesh: 'rgba(192,38,211,0.32)', pupil: '#3b0764', lip: '#a21caf', brow: '#a21caf' },
};

type FaceGroup =
  | 'jaw'
  | 'hair'
  | 'hairSideL'
  | 'hairSideR'
  | 'browL'
  | 'browR'
  | 'eyeLT'
  | 'eyeLB'
  | 'eyeRT'
  | 'eyeRB'
  | 'nose'
  | 'lipT'
  | 'lipB';

interface FacePoint {
  x: number;
  y: number;
  group: FaceGroup;
}

/** 眼睛几何：中心 (±cx, cy)，半轴 (ax, ay) —— 眼眶生成与瞳孔绘制共用 */
const EYE = { cx: 0.24, cy: 0.02, ax: 0.14, ay: 0.07 } as const;

/** 二次贝塞尔 */
function quadBezier(t: number, p0: [number, number], p1: [number, number], p2: [number, number]): [number, number] {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

/** 三次贝塞尔 */
function cubicBezier(
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

/**
 * 生成一帧的所有粒子点。坐标在 [-1,1]² 归一化空间，绘制时再乘 scale 到像素。
 * blink ∈ [0,1]：0=完全张开，1=完全闭眼（上眼睑下落到下眼睑中线，下眼睑略上移）。
 * mouth ∈ [0,1]：嘴张开量，控制上下唇间距。
 * 注意：返回的是"基础几何位置"，渲染时叠加抖动。
 */
function generateFacePoints(blink: number, mouth: number): FacePoint[] {
  const pts: FacePoint[] = [];

  // -------- 下颌（鹅蛋脸下半轮廓，从左耳到右耳过下巴）--------
  // 椭圆 a=0.52, b=0.72
  const JAW_STEPS = 34;
  for (let i = 0; i <= JAW_STEPS; i++) {
    const t = i / JAW_STEPS;
    const angle = Math.PI + t * Math.PI;
    pts.push({ x: 0.52 * Math.cos(angle), y: 0.72 * Math.sin(angle), group: 'jaw' });
  }

  // -------- 头发顶弧（中分柔顺）--------
  const HAIR_STEPS = 28;
  for (let i = 0; i <= HAIR_STEPS; i++) {
    const t = i / HAIR_STEPS;
    const [hx, hy] = cubicBezier(t, [-0.68, -0.2], [-0.42, -1.0], [0.42, -1.0], [0.68, -0.2]);
    pts.push({ x: hx, y: hy, group: 'hair' });
  }
  // 左右两侧垂落到耳后
  const SIDE_STEPS = 14;
  for (let i = 0; i <= SIDE_STEPS; i++) {
    const t = i / SIDE_STEPS;
    const [lx, ly] = quadBezier(t, [-0.68, -0.2], [-0.7, 0.18], [-0.55, 0.45]);
    pts.push({ x: lx, y: ly, group: 'hairSideL' });
    const [rx, ry] = quadBezier(t, [0.68, -0.2], [0.7, 0.18], [0.55, 0.45]);
    pts.push({ x: rx, y: ry, group: 'hairSideR' });
  }

  // -------- 眉毛（柔细弧）--------
  const BROW_STEPS = 12;
  for (let i = 0; i <= BROW_STEPS; i++) {
    const t = i / BROW_STEPS;
    const [lx, ly] = quadBezier(t, [-0.42, -0.13], [-0.27, -0.22], [-0.1, -0.18]);
    pts.push({ x: lx, y: ly, group: 'browL' });
    const [rx, ry] = quadBezier(t, [0.42, -0.13], [0.27, -0.22], [0.1, -0.18]);
    pts.push({ x: rx, y: ry, group: 'browR' });
  }

  // -------- 眼眶（含眨眼）--------
  const EYE_STEPS = 14;
  const lift = 1 - blink; // 上眼睑高度系数
  const lower = 1 - blink * 0.35; // 下眼睑只小幅上移
  for (let i = 0; i <= EYE_STEPS; i++) {
    const t = i / EYE_STEPS;
    const angle = Math.PI - t * Math.PI; // 上半弧
    const dx = EYE.ax * Math.cos(angle);
    const dy = EYE.ay * Math.sin(angle); // sin > 0
    pts.push({ x: -EYE.cx + dx, y: EYE.cy - dy * lift, group: 'eyeLT' });
    pts.push({ x: EYE.cx + dx, y: EYE.cy - dy * lift, group: 'eyeRT' });
  }
  for (let i = 0; i <= EYE_STEPS; i++) {
    const t = i / EYE_STEPS;
    const angle = Math.PI + t * Math.PI; // 下半弧
    const dx = EYE.ax * Math.cos(angle);
    const dy = -EYE.ay * Math.sin(angle); // sin < 0 → dy > 0 朝下
    pts.push({ x: -EYE.cx + dx, y: EYE.cy + dy * lower, group: 'eyeLB' });
    pts.push({ x: EYE.cx + dx, y: EYE.cy + dy * lower, group: 'eyeRB' });
  }

  // -------- 鼻梁 + 鼻尖 --------
  const NOSE_STEPS = 8;
  for (let i = 0; i <= NOSE_STEPS; i++) {
    const t = i / NOSE_STEPS;
    // 从眉间到鼻尖
    const y = -0.05 + t * 0.34;
    const x = Math.sin(t * Math.PI) * 0.018;
    pts.push({ x, y, group: 'nose' });
  }
  // 鼻翼两侧的小弧
  pts.push({ x: -0.05, y: 0.27, group: 'nose' });
  pts.push({ x: 0.05, y: 0.27, group: 'nose' });

  // -------- 嘴唇 --------
  const LIP_STEPS = 18;
  const mouthGap = mouth * 0.07; // 张开量
  for (let i = 0; i <= LIP_STEPS; i++) {
    const t = i / LIP_STEPS;
    // 上唇：两段三次贝塞尔（含丘比特弓），简化为一条二次曲线 + 中点上拱
    const [ux, uy] = quadBezier(t, [-0.18, 0.42], [0, 0.38 - mouthGap * 0.5], [0.18, 0.42]);
    pts.push({ x: ux, y: uy, group: 'lipT' });
    const [bx, by] = quadBezier(t, [-0.18, 0.42], [0, 0.5 + mouthGap], [0.18, 0.42]);
    pts.push({ x: bx, y: by, group: 'lipB' });
  }

  return pts;
}

const MOTION_LERP = 0.18;
const GAZE_LERP = 0.18;
const BLINK_LERP = 0.32;
const MOUTH_LERP = 0.2;
const TILT_LERP = 0.12;

function moodFromActivity(act: AgentActivity): ParticleMood {
  if (act === 'thinking') return 'thinking';
  if (act === 'replying') return 'streaming';
  if (act === 'awake') return 'cheer';
  return 'idle';
}

/** 外晕 sprite 缓存：径向梯度按 (颜色, 半径) 预渲染一次，每帧 drawImage 替代逐粒子 createRadialGradient */
function renderHaloSprite(color: string, r: number): HTMLCanvasElement {
  const size = Math.max(2, Math.ceil(r * 2));
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d');
  if (octx) {
    const grad = octx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, color + 'aa');
    grad.addColorStop(1, color + '00');
    octx.fillStyle = grad;
    octx.fillRect(0, 0, size, size);
  }
  return off;
}

const CartoonAvatar: React.FC<CartoonAvatarProps> = ({ className }) => {
  const theme = useResolvedTheme();
  const themeRef = useRef(theme);
  const blinkPhaseRef = useRef(0);
  const smoothRef = useRef({ scale: 1, headTilt: 0, gazeX: 0, gazeY: 0, blink: 0, mouth: 0 });
  const t0Ref = useRef(0);
  const lastTickRef = useRef(0);
  const haloSpriteRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  const { canvasRef, containerRef } = useCanvas2DLoop({
    dprCap: 2,
    onTick: (ctx, now, { w, h }) => {
      if (w <= 0 || h <= 0) return;
      if (t0Ref.current === 0) t0Ref.current = now;
      const dt = lastTickRef.current > 0 ? (now - lastTickRef.current) / 1000 : 0;
      lastTickRef.current = now;
      const seconds = (now - t0Ref.current) / 1000;

      const st = useParticleStore.getState();
      const motion = st.motion;
      const act = st.agentActivity;
      const override = st.gestureOverride;
      const effMood: ParticleMood = override ? st.mood : moodFromActivity(act);
      const palMap = themeRef.current === 'dark' ? PALETTE_DARK : PALETTE_LIGHT;
      const pal = palMap[effMood];

      // 自动眨眼：周期 4s，最后 5% 时间窗内一次"闭→开"钟形
      blinkPhaseRef.current = (blinkPhaseRef.current + dt / 4) % 1;
      const autoBlink =
        blinkPhaseRef.current > 0.95
          ? Math.sin(((blinkPhaseRef.current - 0.95) / 0.05) * Math.PI)
          : 0;
      const targetBlink = Math.min(1, Math.max(st.blinkAmount, autoBlink));

      // thinking 自带头部缓慢摇摆；override 时由 store.headTilt 接管
      const autoHeadTilt =
        act === 'thinking' && !override ? Math.sin(seconds * 1.2) * (Math.PI / 32) : 0;
      const targetTilt = st.headTilt + autoHeadTilt;

      // replying 自带嘴呼吸式张合
      const autoMouth =
        act === 'replying' && !override ? 0.5 + Math.sin(seconds * 6) * 0.4 : 0;
      const targetMouth = Math.max(st.mouthOpen, autoMouth);

      const s = smoothRef.current;
      s.scale = lerp(s.scale, motion.scale, MOTION_LERP);
      s.headTilt = lerp(s.headTilt, targetTilt, TILT_LERP);
      s.gazeX = lerp(s.gazeX, st.gazeTarget.x, GAZE_LERP);
      s.gazeY = lerp(s.gazeY, st.gazeTarget.y, GAZE_LERP);
      s.blink = lerp(s.blink, targetBlink, BLINK_LERP);
      s.mouth = lerp(s.mouth, targetMouth, MOUTH_LERP);

      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const half = Math.min(w, h) * 0.42 * s.scale;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(s.headTilt);

      // 生成基础几何点
      const basePts = generateFacePoints(s.blink, s.mouth);

      // 微抖动：每个点沿其位置的"角度法线"做小幅 sin 抖动；用 index 作为 phase 散开
      const jitterAmp = Math.max(0.6, half * 0.012);
      const pulse = 1 + Math.sin(seconds * 0.9) * 0.02; // 整体微脉动

      const screenPts: Array<{ x: number; y: number; group: FaceGroup }> = basePts.map((p, i) => {
        const phase = i * 0.61 + seconds * 1.6;
        const jx = Math.cos(phase) * jitterAmp;
        const jy = Math.sin(phase * 1.3) * jitterAmp;
        return {
          x: p.x * half * pulse + jx,
          y: p.y * half * pulse + jy,
          group: p.group,
        };
      });

      // 1) 网格连线：同组相邻点之间画淡线
      ctx.lineWidth = 1;
      ctx.strokeStyle = pal.mesh;
      ctx.beginPath();
      for (let i = 1; i < screenPts.length; i++) {
        const prev = screenPts[i - 1];
        const cur = screenPts[i];
        if (prev.group !== cur.group) continue;
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(cur.x, cur.y);
      }
      ctx.stroke();

      // 2) 外晕粒子（sprite 化径向梯度），先画在底层
      const haloR = Math.max(2.2, half * 0.022);
      const haloKey = `${pal.accent}|${haloR.toFixed(2)}`;
      if (haloSpriteRef.current?.key !== haloKey) {
        haloSpriteRef.current = { key: haloKey, canvas: renderHaloSprite(pal.accent, haloR) };
      }
      const haloSprite = haloSpriteRef.current.canvas;
      for (const p of screenPts) {
        ctx.drawImage(haloSprite, p.x - haloR, p.y - haloR);
      }

      // 3) 核心粒子（亮点）
      const coreR = Math.max(1.0, half * 0.012);
      ctx.fillStyle = pal.primary;
      for (const p of screenPts) {
        // 嘴唇/眉毛改用专属色，更接近"妆容"感
        if (p.group === 'lipT' || p.group === 'lipB') ctx.fillStyle = pal.lip;
        else if (p.group === 'browL' || p.group === 'browR') ctx.fillStyle = pal.brow;
        else ctx.fillStyle = pal.primary;
        ctx.beginPath();
        ctx.arc(p.x, p.y, coreR, 0, Math.PI * 2);
        ctx.fill();
      }

      // 4) 瞳孔：左右各一颗实心圆，受 gaze 控制在眼眶内位移；闭眼接近完全时不画
      if (s.blink < 0.82) {
        const eyeCxL = -EYE.cx * half;
        const eyeCxR = EYE.cx * half;
        const eyeCy = EYE.cy * half;
        const eyeAx = EYE.ax * half;
        const eyeAy = EYE.ay * half;
        const pupilR = Math.max(2.0, half * 0.025);
        const gazeMaxX = eyeAx - pupilR - 2;
        const gazeMaxY = eyeAy - pupilR - 2;
        const px = s.gazeX * gazeMaxX;
        const py = s.gazeY * gazeMaxY;
        const drawPupil = (xCenter: number) => {
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(xCenter, eyeCy, eyeAx - 1, eyeAy - 1, 0, 0, Math.PI * 2);
          ctx.clip();
          ctx.fillStyle = pal.pupil;
          ctx.beginPath();
          ctx.arc(xCenter + px, eyeCy + py, pupilR, 0, Math.PI * 2);
          ctx.fill();
          // 高光
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.arc(xCenter + px - pupilR * 0.35, eyeCy + py - pupilR * 0.35, pupilR * 0.3, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        };
        drawPupil(eyeCxL);
        drawPupil(eyeCxR);
      }

      ctx.restore();

      // cheer / love 时附加飘出的小心形（保留旧形象的语义反馈）
      if (override && (st.mood === 'cheer' || st.mood === 'love')) {
        const heartCx = cx + half * 0.85;
        const heartCy = cy - half * 0.85;
        const heartScale = half * 0.012;
        ctx.save();
        ctx.translate(heartCx, heartCy);
        ctx.scale(heartScale, heartScale);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(0, -3, -5, -3, -5, 1);
        ctx.bezierCurveTo(-5, 5, 0, 8, 0, 12);
        ctx.bezierCurveTo(0, 8, 5, 5, 5, 1);
        ctx.bezierCurveTo(5, -3, 0, -3, 0, 0);
        ctx.closePath();
        ctx.fillStyle = pal.lip;
        ctx.fill();
        ctx.restore();
      }
    },
  });

  return (
    <div ref={containerRef} className={className} style={{ pointerEvents: 'none' }} aria-hidden>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
};

export default CartoonAvatar;
