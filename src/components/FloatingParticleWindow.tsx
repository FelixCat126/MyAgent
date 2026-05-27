import React from 'react';
import ParticleField from './ParticleField';
import { useParticleStore } from '../store/particleStore';

interface FloatingParticleWindowProps {
  visible: boolean;
  themeMode: 'light' | 'dark';
}

/** 与旧版右下角悬浮窗同高（168×168 正方形时的边长） */
const BANNER_HEIGHT = 168;

/**
 * 粒子点阵：嵌在左侧「搜索对话」输入框上方（横向条）；fullscreen 时覆盖整窗。
 */
const FloatingParticleWindow: React.FC<FloatingParticleWindowProps> = ({ visible, themeMode }) => {
  const fullscreen = useParticleStore((s) => s.fullscreen);
  const backgroundColor = themeMode === 'dark' ? '#18181c' : 'var(--shell-chat)';

  if (!visible && !fullscreen) return null;

  return (
    <>
      {visible && !fullscreen ? (
        <div
          className="relative w-full shrink-0 overflow-hidden rounded-lg border border-stone-400/20 bg-stone-100/80 dark:border-white/10 dark:bg-slate-900/50"
          style={{ height: BANNER_HEIGHT }}
          aria-hidden={!visible}
        >
          <ParticleField className="absolute inset-0 overflow-hidden rounded-lg" />
        </div>
      ) : null}
      {fullscreen && visible ? (
        <div
          className="fixed left-0 top-0 z-50 select-none"
          style={{
            backgroundColor,
            width: '100vw',
            height: '100vh',
          }}
          role="region"
          aria-label="Particle preview"
        >
          <ParticleField className="absolute inset-0 overflow-hidden" />
        </div>
      ) : null}
    </>
  );
};

export default FloatingParticleWindow;
