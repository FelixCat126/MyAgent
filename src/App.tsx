import React, { useState, useEffect, useLayoutEffect } from 'react';
import { useChatStore } from './store/chatStore';
import { useModelStore } from './store/modelStore';
import { useSettingStore } from './store/settingStore';
import ChatWindow from './components/ChatWindow';
import SessionList from './components/SessionList';
import SettingsPanel from './components/SettingsPanel';
import OnboardingSteps from './components/OnboardingSteps';
import { FiSettings, FiPlus, FiMoon, FiSun, FiMessageSquare, FiX, FiMonitor } from 'react-icons/fi';
import { useResolvedTheme } from './hooks/useResolvedTheme';
import { useI18n } from './hooks/useI18n';
import type { AppTheme } from './store/settingStore';

const TITLEBAR_H = 44;
/** 底部输入区：输入条（内含模型）+ 发送，单行紧凑高度 */
const FOOTER_H = 76;

const App: React.FC = () => {
  const { createSession, currentSessionId } = useChatStore();
  const { initializeDefaultModels } = useModelStore();
  const theme = useSettingStore((s) => s.theme);
  const setTheme = useSettingStore((s) => s.setTheme);
  const locale = useSettingStore((s) => s.locale);
  const setLocale = useSettingStore((s) => s.setLocale);
  const { t } = useI18n();
  const resolved = useResolvedTheme();
  const [showSettings, setShowSettings] = useState(false);

  useLayoutEffect(() => {
    document.body.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  useEffect(() => {
    initializeDefaultModels();
  }, [initializeDefaultModels]);

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

      {/* 行1右：顶部横线，完全相同颜色贯穿 */}
      <div
        className="border-b border-stone-600/38 dark:border-white/10"
        style={{
          background: resolved === 'dark' ? '#1e1e24' : 'var(--shell-chrome)',
          backdropFilter: 'blur(20px)',
          WebkitAppRegion: 'drag',
        } as any}
      />

      {/* 行2左：会话列表 */}
      <div
        className="border-r border-stone-600/38 dark:border-white/10 overflow-hidden flex flex-col"
        style={{ background: resolved === 'dark' ? '#1c1c22' : 'var(--shell-chrome)' }}
      >
        <SessionList />
      </div>

      {/* 行2右：对话窗口 — flex col, overflow hidden, ChatWindow fills it */}
      <div
        className="overflow-hidden flex flex-col"
        style={{ background: resolved === 'dark' ? '#18181c' : 'var(--shell-chat)' }}
      >
        {currentSessionId ? (
          <ChatWindow footerH={FOOTER_H} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-stone-500 dark:text-slate-500">
            <div
              className="text-center p-10 rounded-3xl border border-stone-600/38 dark:border-white/10 shadow-xl transition-all hover:scale-105"
              style={{ background: resolved === 'dark' ? 'rgba(30,30,36,0.8)' : 'var(--shell-elevated)', backdropFilter: 'blur(20px)' }}
            >
              <div className="w-16 h-16 mx-auto bg-gradient-to-br from-primary-400 to-teal-500 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-primary-500/30">
                <FiMessageSquare className="text-white" size={28} />
              </div>
              <h2 className="text-2xl font-display font-semibold text-stone-800 dark:text-white mb-2">{t('app.brand')}</h2>
              <p className="text-sm text-stone-600 dark:text-slate-400">{t('app.emptyHint')}</p>
            </div>
          </div>
        )}
      </div>

      {/* 行3左：底部操作栏 */}
      <div
        className="border-t border-r border-stone-600/38 dark:border-white/10 flex items-center justify-between px-5"
        style={{ background: resolved === 'dark' ? '#1c1c22' : 'var(--shell-chrome)' }}
      >
        <button
          onClick={handleNewChat}
          className="shrink-0 px-4 py-2 bg-gradient-to-r from-primary-500 to-teal-500 hover:from-primary-600 hover:to-teal-600 shadow-md shadow-primary-500/20 text-white rounded-xl transition-all flex items-center gap-2 font-medium text-sm"
        >
          <FiPlus size={18} />
          <span className="whitespace-nowrap">{t('app.newChat')}</span>
        </button>
        <div className="ml-3 flex shrink-0 items-center gap-0.5">
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
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <SettingsPanel />
        </div>
      </div>

      <OnboardingSteps />
    </div>
  );
};

export default App;
