import React, { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { useChatStore } from './store/chatStore';
import { useModelStore } from './store/modelStore';
import { useSettingStore } from './store/settingStore';
import ChatWindow from './components/ChatWindow';
import SessionList from './components/SessionList';
import SettingsPanel from './components/SettingsPanel';
import OnboardingSteps from './components/OnboardingSteps';
import ErrorToast from './components/ErrorToast';
import ConfirmDialog from './components/ConfirmDialog';
import ImageLibraryDrawer from './components/ImageLibraryDrawer';
import GazeIndicator from './components/GazeIndicator';
import { FiSettings, FiPlus, FiMoon, FiSun, FiMessageSquare, FiX, FiMonitor } from 'react-icons/fi';
import { useResolvedTheme } from './hooks/useResolvedTheme';
import { useI18n } from './hooks/useI18n';
import { useGestureControl } from './hooks/useGestureControl';
import { useFaceTracking } from './hooks/useFaceTracking';
import { useMainWindowFocused } from './hooks/useMainWindowFocused';
import { useParticleStore } from './store/particleStore';
import type { AppTheme } from './store/settingStore';
import { flushZustandFilePersist } from './utils/zustandFileStorage';
import { installGestureScrollMomentum } from './utils/gestureScrollMomentum';
import { getGestureUiPhase, setGestureUiPhase } from './utils/gestureUiContext';
import { ImageLibraryContext } from './context/ImageLibraryContext';

const TITLEBAR_H = 44;
/** 底部输入区：输入条（内含模型）+ 发送，单行紧凑高度 */
const FOOTER_H = 76;

const App: React.FC = () => {
  const { createSession, currentSessionId, sessions } = useChatStore();
  const { initializeDefaultModels } = useModelStore();
  const theme = useSettingStore((s) => s.theme);
  const setTheme = useSettingStore((s) => s.setTheme);
  const locale = useSettingStore((s) => s.locale);
  const setLocale = useSettingStore((s) => s.setLocale);
  const { t } = useI18n();
  const resolved = useResolvedTheme();
  const gestureControlEnabled = useSettingStore((s) => s.gestureControlEnabled);
  const windowFocused = useMainWindowFocused();
  /** 手势/视觉开启即占用摄像头；面部追踪复用同一路 video 流做眨眼检测 */
  const gesture = useGestureControl(gestureControlEnabled);
  useFaceTracking(gestureControlEnabled, gesture.videoElement, true);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (showSettings) {
      setGestureUiPhase('settings-drawer');
      return;
    }
    if (getGestureUiPhase() === 'settings-drawer') {
      setGestureUiPhase('idle');
    }
  }, [showSettings]);

  const { label: gestureStatusLabel, tone: gestureStatusTone } = (() => {
    switch (gesture.status.kind) {
      case 'loading-model':
        return { label: t('gesture.status.loadingModel'), tone: 'pending' as const };
      case 'requesting-camera':
        return { label: t('gesture.status.requestingCamera'), tone: 'pending' as const };
      case 'ready':
        return { label: t('gesture.status.ready'), tone: 'ready' as const };
      case 'model-missing':
        return { label: t('gesture.status.modelMissing'), tone: 'error' as const };
      case 'permission-denied':
        return { label: t('gesture.status.permissionDenied'), tone: 'error' as const };
      case 'error':
        return {
          label: `${t('gesture.status.error')}: ${gesture.status.message?.slice(0, 60) ?? ''}`,
          tone: 'error' as const,
        };
      default:
        return { label: t('gesture.status.loadingModel'), tone: 'warn' as const };
    }
  })();
  const [imageLibraryOpen, setImageLibraryOpen] = useState(false);
  const openImageLibrary = useCallback(() => setImageLibraryOpen(true), []);

  useLayoutEffect(() => {
    document.body.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  useEffect(() => {
    initializeDefaultModels();
  }, [initializeDefaultModels]);

  /**
   * 手势业务：握拳→张掌打开图库，张掌→握拳关闭图库。
   */
  useEffect(() => {
    if (!gestureControlEnabled) return;
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: string }>).detail;
      if (!detail) return;
      switch (detail.kind) {
        case 'open-image-library':
          setImageLibraryOpen(true);
          break;
        case 'close-image-library':
          setImageLibraryOpen(false);
          break;
        default:
          break;
      }
    };
    window.addEventListener('myagent-gesture-action', onAction as EventListener);
    return () => window.removeEventListener('myagent-gesture-action', onAction as EventListener);
  }, [gestureControlEnabled]);

  /**
   * 双眨眼 → 切换设置抽屉。
   */
  useEffect(() => {
    if (!gestureControlEnabled) return;
    const onDoubleBlink = () => setShowSettings((v) => !v);
    window.addEventListener('myagent-double-blink', onDoubleBlink as EventListener);
    return () =>
      window.removeEventListener('myagent-double-blink', onDoubleBlink as EventListener);
  }, [gestureControlEnabled]);

  /**
   * 单眨眼 → 在食指光标位置模拟点击。
   */
  useEffect(() => {
    if (!gestureControlEnabled) return;
    const onGazeClick = (e: Event) => {
      if (!windowFocused) return;
      const detail = (e as CustomEvent<{ x: number; y: number } | null>).detail;
      const pos = detail ?? useParticleStore.getState().gazeScreenPos;
      if (!pos || !window.electron?.simulateGazeClick) return;
      void window.electron.simulateGazeClick(pos.x, pos.y);
    };
    window.addEventListener('myagent-gaze-click', onGazeClick as EventListener);
    return () => window.removeEventListener('myagent-gaze-click', onGazeClick as EventListener);
  }, [gestureControlEnabled, windowFocused]);

  /**
   * 张掌上下划 → 跟手 + 惯性滚动（聊天 / 图库 / 设置抽屉）。
   */
  useEffect(() => {
    if (!gestureControlEnabled) return;
    return installGestureScrollMomentum();
  }, [gestureControlEnabled]);

  useEffect(() => {
    const win = window as Window & {
      __MYAGENT_FLUSH_PERSIST__?: () => Promise<void>;
    };
    win.__MYAGENT_FLUSH_PERSIST__ = () => flushZustandFilePersist();
    const flush = () => {
      void flushZustandFilePersist();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      flush();
      delete win.__MYAGENT_FLUSH_PERSIST__;
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  const handleNewChat = () => createSession();

  const cycleTheme = () => {
    const next: AppTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const themeIcon =
    theme === 'system' ? <FiMonitor size={18} /> : theme === 'light' ? <FiSun size={18} /> : <FiMoon size={18} />;
  const themeTitle = `${t('app.theme.cycle')}: ${
    theme === 'system' ? t('app.theme.system') : theme === 'light' ? t('app.theme.light') : t('app.theme.dark')
  }`;

  return (
    <ImageLibraryContext.Provider value={{ openImageLibrary }}>
    <div
      className="h-screen w-screen overflow-hidden"
      style={{
        display: 'grid',
        gridTemplateRows: `${TITLEBAR_H}px 1fr ${FOOTER_H}px`,
        gridTemplateColumns: '256px 1fr',
        color: resolved === 'dark' ? undefined : '#3d3a36',
        backgroundColor: resolved === 'dark' ? '#18181c' : 'var(--shell-bg)',
      }}
    >
      {/* 行1左：红绿灯拖拽区 */}
      <div
        className="border-b border-stone-600/38 dark:border-white/10"
        style={{
          background: resolved === 'dark' ? '#1e1e24' : 'var(--shell-chrome)',
          backdropFilter: 'blur(20px)',
          WebkitAppRegion: 'drag',
        } as any}
      />

      {/* 行1右：顶部横线，完全相同颜色贯穿；手势/视觉识别开启后在右侧嵌入识别状态 */}
      <div
        className="relative flex items-center justify-end border-b border-stone-600/38 px-4 dark:border-white/10"
        style={{
          background: resolved === 'dark' ? '#1e1e24' : 'var(--shell-chrome)',
          backdropFilter: 'blur(20px)',
          WebkitAppRegion: 'drag',
        } as any}
      >
        {gestureControlEnabled ? (
          <div
            className={
              'flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ' +
              (resolved === 'dark'
                ? 'bg-white/10 text-slate-200'
                : 'bg-stone-500/15 text-stone-700')
            }
            style={{ WebkitAppRegion: 'no-drag' } as any}
            title={gestureStatusLabel}
          >
            <span className="relative inline-flex h-2 w-2 items-center justify-center">
              <span
                className={
                  'absolute inset-0 rounded-full ' +
                  (gestureStatusTone === 'ready'
                    ? 'bg-emerald-400/55 animate-ping'
                    : gestureStatusTone === 'pending'
                      ? 'bg-amber-400/55 animate-ping'
                      : 'bg-transparent')
                }
              />
              <span
                className={
                  'relative h-1.5 w-1.5 rounded-full ' +
                  (gestureStatusTone === 'ready'
                    ? 'bg-emerald-500'
                    : gestureStatusTone === 'pending'
                      ? 'bg-amber-500'
                      : gestureStatusTone === 'warn'
                        ? 'bg-zinc-400'
                        : 'bg-rose-500')
                }
              />
            </span>
            <span className="truncate">{gestureStatusLabel}</span>
          </div>
        ) : null}
      </div>

      {/* 行2左：会话列表 */}
      <div
        className="border-r border-stone-600/38 dark:border-white/10 overflow-hidden flex flex-col"
        style={{ background: resolved === 'dark' ? '#1c1c22' : 'var(--shell-chrome)' }}
      >
        <SessionList />
      </div>

      {/* 行2右：对话窗口 — flex col, overflow hidden, ChatWindow fills it */}
      <div
        className="relative flex min-h-0 flex-col overflow-hidden"
        style={{ background: resolved === 'dark' ? '#18181c' : 'var(--shell-chat)' }}
      >
        {currentSessionId ? (
          <ChatWindow footerH={FOOTER_H} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-stone-500 dark:text-slate-500">
            <div
              className="rounded-3xl border border-stone-600/38 p-10 text-center shadow-xl transition-all hover:scale-105 dark:border-white/10"
              style={{ background: resolved === 'dark' ? 'rgba(30,30,36,0.8)' : 'var(--shell-elevated)', backdropFilter: 'blur(20px)' }}
            >
              <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-400 to-teal-500 shadow-lg shadow-primary-500/30">
                <FiMessageSquare className="text-white" size={28} />
              </div>
              <h2 className="mb-2 font-display text-2xl font-semibold text-stone-800 dark:text-white">{t('app.brand')}</h2>
              <p className="text-sm text-stone-600 dark:text-slate-400">{t('app.emptyHint')}</p>
            </div>
          </div>
        )}
        <ImageLibraryDrawer
          open={imageLibraryOpen}
          sessions={sessions}
          onClose={() => setImageLibraryOpen(false)}
        />
      </div>

      {/* 行3左：底部操作栏 */}
      <div
        className="flex items-center justify-between gap-2 overflow-x-auto border-t border-r border-stone-600/38 px-5 dark:border-white/10"
        style={{ background: resolved === 'dark' ? '#1c1c22' : 'var(--shell-chrome)' }}
      >
        <button
          onClick={handleNewChat}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-gradient-to-r from-primary-500 to-teal-500 px-4 py-2 text-sm font-medium text-white shadow-md shadow-primary-500/20 transition-all hover:from-primary-600 hover:to-teal-600"
        >
          <FiPlus size={18} className="shrink-0" />
          <span className="whitespace-nowrap">{t('app.newChat')}</span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
            className="flex h-9 min-w-[2.25rem] items-center justify-center rounded-lg p-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-400/20 dark:text-slate-300 dark:hover:bg-white/10"
            title={t('app.lang.cycle')}
          >
            {locale === 'zh' ? 'EN' : '中'}
          </button>
          <button
            type="button"
            onClick={cycleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-lg p-2 text-stone-600 transition-colors hover:bg-stone-400/20 dark:text-slate-400 dark:hover:bg-white/10"
            title={themeTitle}
          >
            {themeIcon}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="flex h-9 w-9 items-center justify-center rounded-lg p-2 text-stone-600 transition-colors hover:bg-stone-400/20 dark:text-slate-400 dark:hover:bg-white/10"
            title={t('app.settings')}
          >
            <FiSettings size={18} />
          </button>
        </div>
      </div>

      {/* 行3右：由 ChatWindow 的 fixed footer 占据（此格仅撑起 grid 行高） */}
      <div style={{ background: resolved === 'dark' ? '#18181c' : 'var(--shell-chat)' }} />

      {/* 设置抽屉遮罩：淡入淡出，点击关闭 */}
      <div
        className={`fixed z-40 bg-stone-900/15 transition-opacity duration-300 ease-in-out dark:bg-black/35 ${
          showSettings ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        style={{ top: TITLEBAR_H, bottom: FOOTER_H, left: 256, right: 0 }}
        aria-hidden={!showSettings}
        onClick={() => setShowSettings(false)}
      />

      <div
        className={`fixed right-0 z-50 flex w-96 max-w-[100vw] min-h-0 flex-col border-l border-stone-600/38 bg-[var(--shell-settings)] shadow-[-8px_0_32px_-12px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-in-out will-change-transform dark:border-white/10 dark:bg-[rgba(28,28,34,0.97)] ${
          showSettings ? 'translate-x-0' : 'pointer-events-none translate-x-full'
        }`}
        data-gesture-drawer="settings"
        data-gesture-drawer-open={showSettings ? 'true' : 'false'}
        style={{
          top: TITLEBAR_H,
          bottom: FOOTER_H,
          backdropFilter: 'blur(24px)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        aria-hidden={!showSettings}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-400/25 px-3 py-2.5 dark:border-white/10">
          <h2 id="settings-drawer-title" className="text-sm font-semibold text-stone-800 dark:text-white">
            {t('app.settings')}
          </h2>
          <button
            type="button"
            onClick={() => setShowSettings(false)}
            className="rounded-lg p-2 text-stone-500 transition-colors hover:bg-stone-400/20 hover:text-stone-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
            title={t('app.close')}
            aria-label={t('app.close')}
          >
            <FiX size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsPanel />
        </div>
      </div>

      <OnboardingSteps />
      <GazeIndicator
        visible={gestureControlEnabled && gesture.cameraActive}
        windowFocused={windowFocused}
        themeMode={resolved}
      />
      <ErrorToast />
      <ConfirmDialog />
    </div>
    </ImageLibraryContext.Provider>
  );
};

export default App;
