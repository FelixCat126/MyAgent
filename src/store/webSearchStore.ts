import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WebSearchProvider } from '../types';
import { zustandPersistJson } from '../utils/zustandFileStorage';

interface WebSearchStore {
  enabled: boolean;
  provider: WebSearchProvider;
  apiKey: string;
  setEnabled: (v: boolean) => void;
  setProvider: (p: WebSearchProvider) => void;
  setApiKey: (k: string) => void;
}

export const useWebSearchStore = create<WebSearchStore>()(
  persist(
    (set) => ({
      /** 关键词已限制请求频率，默认开启；可在设置中关闭 */
      enabled: true,
      provider: 'duckduckgo',
      apiKey: '',
      setEnabled: (enabled) => set({ enabled }),
      setProvider: (provider) => set({ provider }),
      setApiKey: (apiKey) => set({ apiKey }),
    }),
    {
      name: 'web-search-storage',
      version: 1,
      storage: zustandPersistJson,
      migrate: (persistedState: unknown) => {
        const s = persistedState as Record<string, unknown> | null;
        if (!s || typeof s !== 'object') return persistedState as Partial<WebSearchStore>;
        const next = { ...s } as Record<string, unknown>;
        if (next.provider === 'searxng') next.provider = 'duckduckgo';
        delete next.searxngUrl;
        return next as Partial<WebSearchStore>;
      },
    }
  )
);
