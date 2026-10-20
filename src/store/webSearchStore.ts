import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WebSearchProvider } from '../types';
import { PERSIST_KEYS } from '../utils/persistKeys';
import { zustandPersistJson } from '../utils/zustandFileStorage';

type KeyedProvider = 'tavily' | 'brave';
/** 每家各存一份；嵌套键仍叫 apiKey，落盘时会被敏感字段加密 */
type ProviderKeys = Record<KeyedProvider, { apiKey: string }>;

interface WebSearchStore {
  enabled: boolean;
  provider: WebSearchProvider;
  /** 当前 provider 的密钥（由 keys 派生，供发送链路直接读取） */
  apiKey: string;
  keys: ProviderKeys;
  setEnabled: (v: boolean) => void;
  setProvider: (p: WebSearchProvider) => void;
  setApiKey: (k: string) => void;
}

const isKeyed = (p: unknown): p is KeyedProvider => p === 'tavily' || p === 'brave';
const emptyKeys = (): ProviderKeys => ({ tavily: { apiKey: '' }, brave: { apiKey: '' } });
const keyOf = (keys: ProviderKeys, p: WebSearchProvider) => (isKeyed(p) ? keys?.[p]?.apiKey ?? '' : '');

export const useWebSearchStore = create<WebSearchStore>()(
  persist(
    (set) => ({
      /** 关键词已限制请求频率，默认开启；可在设置中关闭 */
      enabled: true,
      provider: 'duckduckgo',
      apiKey: '',
      keys: emptyKeys(),
      setEnabled: (enabled) => set({ enabled }),
      setProvider: (provider) => set((state) => ({ provider, apiKey: keyOf(state.keys, provider) })),
      setApiKey: (apiKey) =>
        set((state) => isKeyed(state.provider)
          ? { apiKey, keys: { ...state.keys, [state.provider]: { apiKey } } }
          : { apiKey }),
    }),
    {
      name: PERSIST_KEYS.webSearch,
      version: 2,
      storage: zustandPersistJson,
      migrate: (persistedState: unknown, version) => {
        const s = persistedState as Record<string, unknown> | null;
        if (!s || typeof s !== 'object') return persistedState as Partial<WebSearchStore>;
        const next = { ...s } as Record<string, unknown>;
        if (next.provider === 'searxng') next.provider = 'duckduckgo';
        delete next.searxngUrl;
        if (version < 2) {
          /** v1 只有一份共用密钥：归给当前选中的那家；未选付费源时两家都保留，避免丢失 */
          const legacy = typeof next.apiKey === 'string' ? next.apiKey : '';
          const keys = emptyKeys();
          if (isKeyed(next.provider)) keys[next.provider].apiKey = legacy;
          else { keys.tavily.apiKey = legacy; keys.brave.apiKey = legacy; }
          next.keys = keys;
          next.apiKey = isKeyed(next.provider) ? legacy : '';
        }
        return next as Partial<WebSearchStore>;
      },
    }
  )
);
