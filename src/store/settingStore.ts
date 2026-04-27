import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { applyBodyClassForStoredTheme } from '../utils/themeDocument';
import type { Locale } from '../i18n/types';

export type AppTheme = 'light' | 'dark' | 'system';

interface SettingStore {
  /** 默认跟随系统；显式选浅色/深色后写入 light/dark；system=跟随 */
  theme: AppTheme;
  fontSize: number;
  autoSave: boolean;
  streamResponses: boolean;
  locale: Locale;
  setTheme: (theme: AppTheme) => void;
  setFontSize: (size: number) => void;
  setAutoSave: (autoSave: boolean) => void;
  setStreamResponses: (v: boolean) => void;
  setLocale: (locale: Locale) => void;
}

export const useSettingStore = create<SettingStore>()(
  persist(
    (set) => ({
      theme: 'system',
      fontSize: 14,
      autoSave: true,
      streamResponses: true,
      locale: 'zh',
      setTheme: (theme: AppTheme) => {
        set({ theme });
        applyBodyClassForStoredTheme(theme);
      },
      setFontSize: (size: number) => {
        set({ fontSize: size });
      },
      setAutoSave: (autoSave: boolean) => {
        set({ autoSave });
      },
      setStreamResponses: (v: boolean) => {
        set({ streamResponses: v });
      },
      setLocale: (locale: Locale) => {
        set({ locale });
      },
    }),
    {
      name: 'setting-storage',
      version: 2,
      storage: zustandPersistJson,
      migrate: (persisted, version) => {
        if (version >= 2) return persisted as object;
        const s = (persisted || {}) as Partial<SettingStore> & { theme?: string; locale?: string };
        return {
          ...s,
          theme:
            s.theme === 'light' || s.theme === 'dark' ? s.theme : ((s.theme as string) || 'system'),
          locale: s.locale === 'en' || s.locale === 'zh' ? s.locale : 'zh',
        } as object;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        applyBodyClassForStoredTheme(state.theme);
      },
    }
  )
);
