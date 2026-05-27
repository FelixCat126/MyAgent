import React, { useCallback, useEffect, useRef, useState } from 'react';
import ParticleField from './ParticleField';
import { useParticleStore } from '../store/particleStore';

interface FloatingParticleWindowProps {
  /** 控制可见性；用 opacity 实现淡入淡出，配合 visibility 在隐藏后跳出 hit-test */
  visible: boolean;
  /** 跟随 App 的解析主题，用来决定浮窗背景色（与对话区背景同色） */
  themeMode: 'light' | 'dark';
}

/**
 * 浮窗默认尺寸 / 默认位置。
 *
 * 与 App.tsx 的布局常量保持隐式一致：
 *  - 底部输入栏占 `FOOTER_H = 76px`，对应 `gridTemplateRows`
 *  - 默认贴在对话区域右下角；距视口右边 = 距 footer 上沿 = `DEFAULT_MARGIN`（等距 M = 14）
 *  - 缩小到 168×168（原 228），避免在对话提交后遮挡最新消息底部
 *  - 仍保持 1:1 正方形，与圆形点阵的对称感匹配
 */
const FOOTER_H = 76;
const DEFAULT_MARGIN = 14;
const WINDOW_W = 168;
const WINDOW_H = WINDOW_W;
const DEFAULT_OFFSET_RIGHT = DEFAULT_MARGIN;
const DEFAULT_OFFSET_BOTTOM = FOOTER_H + DEFAULT_MARGIN;

/**
 * 粒子点阵悬浮窗：承载 ParticleField，由 useGestureControl / 业务态写入的 motion/mood 驱动。
 * 「手势识别中」状态指示已迁移至顶栏右上，与最小化按钮同行。
 *
 * 工程约定：
 * - 背景与对话区主色一致（暗色 #18181c / 浅色 --shell-chat），不再使用半透明 + 模糊；
 * - 可拖动：主体任一处按下都进入拖动；松开后保存到内部 state；
 * - 隐藏：opacity 0 + visibility hidden 同时生效，配合 transition 做 200ms 淡出；
 * - RAF：visible=false 时通过条件挂载彻底卸载 ParticleField，避免后台空转耗电；
 * - 整窗 `cursor: grab/grabbing`，与系统悬浮控件的常见交互直觉对齐。
 */
const FloatingParticleWindow: React.FC<FloatingParticleWindowProps> = ({ visible, themeMode }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef<{ ox: number; oy: number } | null>(null);
  /** 全屏由 particleStore 控制，方便手势（"双手张开极限"或 OK 长按）直接切换 */
  const fullscreen = useParticleStore((s) => s.fullscreen);

  useEffect(() => {
    if (!visible || fullscreen) return;
    const onMove = (e: MouseEvent) => {
      const o = dragOffsetRef.current;
      if (!o) return;
      const x = e.clientX - o.ox;
      const y = e.clientY - o.oy;
      /** 约束到视口范围内，避免拖出屏幕回不来 */
      const maxX = Math.max(0, window.innerWidth - WINDOW_W);
      const maxY = Math.max(0, window.innerHeight - WINDOW_H);
      setPos({
        x: Math.min(Math.max(0, x), maxX),
        y: Math.min(Math.max(0, y), maxY),
      });
    };
    const onUp = () => {
      dragOffsetRef.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [visible, fullscreen]);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || fullscreen) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragOffsetRef.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    setDragging(true);
    if (!pos) {
      setPos({ x: rect.left, y: rect.top });
    }
  }, [pos, fullscreen]);

  const positionStyle: React.CSSProperties = fullscreen
    ? { left: 0, top: 0 }
    : pos
      ? { left: pos.x, top: pos.y }
      : { right: DEFAULT_OFFSET_RIGHT, bottom: DEFAULT_OFFSET_BOTTOM };

  const sizeStyle: React.CSSProperties = fullscreen
    ? { width: '100vw', height: '100vh', borderRadius: 0 }
    : { width: WINDOW_W, height: WINDOW_H };

  /** 浮窗背景与对话区主色一致：暗色用 #18181c，浅色用 --shell-chat */
  const backgroundColor = themeMode === 'dark' ? '#18181c' : 'var(--shell-chat)';

  return (
    <div
      className={
        'fixed z-40 select-none transition-[opacity,visibility] duration-200 ' +
        (fullscreen
          ? 'rounded-none border-0 '
          : 'rounded-2xl border border-stone-500/15 dark:border-white/10 ') +
        (visible ? 'opacity-100 visible' : 'pointer-events-none invisible opacity-0')
      }
      style={{
        cursor: fullscreen ? 'default' : dragging ? 'grabbing' : 'grab',
        backgroundColor,
        ...sizeStyle,
        ...positionStyle,
      }}
      onMouseDown={onMouseDown}
      role="region"
      aria-label="Particle preview"
      aria-hidden={!visible}
    >
      {visible ? (
        <ParticleField
          className={
            fullscreen
              ? 'absolute inset-0 overflow-hidden'
              : 'absolute inset-0 overflow-hidden rounded-2xl'
          }
        />
      ) : null}
    </div>
  );
};

export default FloatingParticleWindow;
