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
  /** 启用后显示麦克风；火山密钥区仅在开启时展开，填齐且 Electron 下优先 OpenSpeech */
  speechInputEnabled: boolean;
  volcAsrAppKey: string;
  volcAsrAccessKey: string;
  volcAsrResourceId: string;
  setTheme: (theme: AppTheme) => void;
  setFontSize: (size: number) => void;
  setAutoSave: (autoSave: boolean) => void;
  setStreamResponses: (v: boolean) => void;
  setLocale: (locale: Locale) => void;
  setSpeechInputEnabled: (v: boolean) => void;
  setVolcAsrAppKey: (v: string) => void;
  setVolcAsrAccessKey: (v: string) => void;
  setVolcAsrResourceId: (v: string) => void;
}

export const useSettingStore = create<SettingStore>()(
  persist(
    (set) => ({
      theme: 'system',
      fontSize: 14,
      autoSave: true,
      streamResponses: true,
      locale: 'zh',
      speechInputEnabled: true,
      volcAsrAppKey: '',
      volcAsrAccessKey: '',
      volcAsrResourceId: '',
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
      setSpeechInputEnabled: (v: boolean) => set({ speechInputEnabled: v }),
      setVolcAsrAppKey: (v: string) => set({ volcAsrAppKey: v }),
      setVolcAsrAccessKey: (v: string) => set({ volcAsrAccessKey: v }),
      setVolcAsrResourceId: (v: string) => set({ volcAsrResourceId: v }),
    }),
    {
      name: 'setting-storage',
      version: 6,
      storage: zustandPersistJson,
      migrate: (persisted, version) => {
        const baseMerged =
          version >= 2
            ? ({ ...(persisted as object) } as Record<string, unknown>)
            : {
                ...(persisted as object),
                locale: 'zh',
                theme:
                  (persisted as { theme?: string })?.theme === 'light' ||
                  (persisted as { theme?: string })?.theme === 'dark'
                    ? (persisted as { theme?: string }).theme
                    : 'system',
              };
        delete baseMerged.volcAsrWakePhrase;
        delete baseMerged.volcAsrStopPhrases;
        delete baseMerged.volcAsrEnabled;

        const s = baseMerged as Partial<SettingStore> & Partial<{ speechInputEnabled: boolean }>;
        const speechIn =
          typeof s.speechInputEnabled === 'boolean' ? s.speechInputEnabled : true;
        const volcMerged = {
          ...baseMerged,
          speechInputEnabled: speechIn,
          volcAsrAppKey: typeof s.volcAsrAppKey === 'string' ? s.volcAsrAppKey : '',
          volcAsrAccessKey: typeof s.volcAsrAccessKey === 'string' ? s.volcAsrAccessKey : '',
          volcAsrResourceId: typeof s.volcAsrResourceId === 'string' ? s.volcAsrResourceId : '',
        };
        return volcMerged as object;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        applyBodyClassForStoredTheme(state.theme);
      },
    }
  )
);
