import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PERSIST_KEYS } from '../utils/persistKeys';
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
  /** 语音唤醒：后台监听唤醒词，命中后自动进入听写（无需点麦克风） */
  voiceWakeEnabled: boolean;
  /** 唤醒词，如「小媛小媛」；空则视为关闭唤醒 */
  voiceWakePhrase: string;
  /** 助手回复分段语音播报（不播报思考过程） */
  voiceReplyEnabled: boolean;
  volcAsrAppKey: string;
  volcAsrAccessKey: string;
  volcAsrResourceId: string;
  /** 启用后打开摄像头进行 MediaPipe 手势识别，将识别结果映射到对话区粒子层；默认关闭，纯本机推理 */
  gestureControlEnabled: boolean;
  /** 点阵悬浮窗显示开关；独立于手势识别——关闭手势识别后，点阵仍能由业务态（唤醒/思考/回复）驱动 */
  particleFieldEnabled: boolean;
  /** 视线跟随：开启后显示目光光标、支持 9 点校准；眨眼一次在光标处点击，连续眨眼两次切换设置抽屉 */
  gazeFollowEnabled: boolean;
  /** 水下 Agent：本机文档检索/读取/导出（全机范围，系统核心目录需授权） */
  agentLocalToolsEnabled: boolean;
  /** 水下 Agent：对话区内嵌浏览（默认开，可在设置关闭） */
  agentBrowserEnabled: boolean;
  /** Agent 禁止访问的路径（非授权列表，每行一条；系统核心目录已内置禁止） */
  agentDeniedPaths: string[];
  setTheme: (theme: AppTheme) => void;
  setFontSize: (size: number) => void;
  setAutoSave: (autoSave: boolean) => void;
  setStreamResponses: (v: boolean) => void;
  setLocale: (locale: Locale) => void;
  setSpeechInputEnabled: (v: boolean) => void;
  setVoiceWakeEnabled: (v: boolean) => void;
  setVoiceWakePhrase: (v: string) => void;
  setVoiceReplyEnabled: (v: boolean) => void;
  setVolcAsrAppKey: (v: string) => void;
  setVolcAsrAccessKey: (v: string) => void;
  setVolcAsrResourceId: (v: string) => void;
  setGestureControlEnabled: (v: boolean) => void;
  setParticleFieldEnabled: (v: boolean) => void;
  setGazeFollowEnabled: (v: boolean) => void;
  setAgentLocalToolsEnabled: (v: boolean) => void;
  setAgentBrowserEnabled: (v: boolean) => void;
  setAgentDeniedPaths: (paths: string[]) => void;
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
      voiceWakeEnabled: false,
      voiceWakePhrase: '小媛小媛',
      voiceReplyEnabled: false,
      volcAsrAppKey: '',
      volcAsrAccessKey: '',
      volcAsrResourceId: '',
      gestureControlEnabled: false,
      particleFieldEnabled: true,
      gazeFollowEnabled: false,
      agentLocalToolsEnabled: false,
      agentBrowserEnabled: true,
      agentDeniedPaths: [],
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
      setVoiceWakeEnabled: (v: boolean) => set({ voiceWakeEnabled: v }),
      setVoiceWakePhrase: (v: string) => set({ voiceWakePhrase: v }),
      setVoiceReplyEnabled: (v: boolean) => set({ voiceReplyEnabled: v }),
      setVolcAsrAppKey: (v: string) => set({ volcAsrAppKey: v }),
      setVolcAsrAccessKey: (v: string) => set({ volcAsrAccessKey: v }),
      setVolcAsrResourceId: (v: string) => set({ volcAsrResourceId: v }),
      setGestureControlEnabled: (v: boolean) => set({ gestureControlEnabled: v }),
      setParticleFieldEnabled: (v: boolean) => set({ particleFieldEnabled: v }),
      setGazeFollowEnabled: (v: boolean) => set({ gazeFollowEnabled: v }),
      setAgentLocalToolsEnabled: (v: boolean) => set({ agentLocalToolsEnabled: v }),
      setAgentBrowserEnabled: (v: boolean) => set({ agentBrowserEnabled: v }),
      setAgentDeniedPaths: (paths: string[]) =>
        set({
          agentDeniedPaths: [...new Set(paths.map((p) => p.trim()).filter(Boolean))],
        }),
    }),
    {
      name: PERSIST_KEYS.setting,
      version: 15,
      storage: zustandPersistJson,
      migrate: (persisted, version) => {
        const raw = persisted as Record<string, unknown>;
        const baseMerged =
          version >= 2
            ? ({ ...raw } as Record<string, unknown>)
            : {
                ...raw,
                locale: 'zh',
                theme:
                  raw?.theme === 'light' || raw?.theme === 'dark' ? raw.theme : 'system',
              };

        const legacyWake =
          typeof raw.volcAsrWakePhrase === 'string' ? raw.volcAsrWakePhrase.trim() : '';
        delete baseMerged.volcAsrWakePhrase;
        delete baseMerged.volcAsrStopPhrases;
        delete baseMerged.volcAsrEnabled;

        const s = baseMerged as Partial<SettingStore> & Partial<{ speechInputEnabled: boolean }>;
        const speechIn =
          typeof s.speechInputEnabled === 'boolean' ? s.speechInputEnabled : true;
        const sg = baseMerged as Partial<SettingStore> &
          Partial<{
            gestureControlEnabled: boolean;
            particleFieldEnabled: boolean;
            voiceWakeEnabled: boolean;
            voiceWakePhrase: string;
            voiceReplyEnabled: boolean;
          }>;

        const volcMerged = {
          ...baseMerged,
          speechInputEnabled: speechIn,
          voiceWakeEnabled:
            typeof sg.voiceWakeEnabled === 'boolean' ? sg.voiceWakeEnabled : false,
          voiceWakePhrase: (() => {
            const cur =
              typeof sg.voiceWakePhrase === 'string' && sg.voiceWakePhrase.trim()
                ? sg.voiceWakePhrase.trim()
                : legacyWake || '小媛小媛';
            /** v8 默认唤醒词升级：仅当仍为旧默认值时自动迁移 */
            if (version < 9 && cur === '小助手') return '小媛小媛';
            return cur;
          })(),
          voiceReplyEnabled:
            typeof sg.voiceReplyEnabled === 'boolean' ? sg.voiceReplyEnabled : false,
          volcAsrAppKey: typeof s.volcAsrAppKey === 'string' ? s.volcAsrAppKey : '',
          volcAsrAccessKey: typeof s.volcAsrAccessKey === 'string' ? s.volcAsrAccessKey : '',
          volcAsrResourceId: typeof s.volcAsrResourceId === 'string' ? s.volcAsrResourceId : '',
          gestureControlEnabled:
            typeof sg.gestureControlEnabled === 'boolean' ? sg.gestureControlEnabled : false,
          particleFieldEnabled:
            typeof sg.particleFieldEnabled === 'boolean' ? sg.particleFieldEnabled : true,
          gazeFollowEnabled:
            typeof (baseMerged as { gazeFollowEnabled?: boolean }).gazeFollowEnabled === 'boolean'
              ? (baseMerged as { gazeFollowEnabled: boolean }).gazeFollowEnabled
              : false,
          agentLocalToolsEnabled:
            typeof (baseMerged as { agentLocalToolsEnabled?: boolean }).agentLocalToolsEnabled ===
            'boolean'
              ? (baseMerged as { agentLocalToolsEnabled: boolean }).agentLocalToolsEnabled
              : false,
          agentBrowserEnabled:
            typeof (baseMerged as { agentBrowserEnabled?: boolean }).agentBrowserEnabled === 'boolean'
              ? (baseMerged as { agentBrowserEnabled: boolean }).agentBrowserEnabled
              : false,
          agentDeniedPaths: Array.isArray((baseMerged as { agentDeniedPaths?: unknown }).agentDeniedPaths)
            ? ((baseMerged as { agentDeniedPaths: string[] }).agentDeniedPaths ?? [])
                .map((p) => String(p).trim())
                .filter(Boolean)
            : [],
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
