import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import type { EmbeddingProviderKey, KnowledgeEmbedConfig } from '../types';

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

interface KnowledgeStore {
  /** 发送给模型前是否注入「工作区向量检索」片段 */
  vectorRagEnabled: boolean;
  vectorTopK: number;
  /** 注入内容总长度上限 */
  ragMaxInjectChars: number;
  embeddingProvider: EmbeddingProviderKey;
  embeddingApiUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  /** 豆包 Doubao-embedding-vision 且模型名仅 ep- 时，需手动开启（名称含 embedding-vision 且为方舟址时常自动为 true） */
  embeddingVolcMultimodal: boolean;
  setVectorRagEnabled: (v: boolean) => void;
  setVectorTopK: (n: number) => void;
  setRagMaxInjectChars: (n: number) => void;
  setEmbeddingProvider: (p: EmbeddingProviderKey) => void;
  setEmbeddingApiUrl: (u: string) => void;
  setEmbeddingApiKey: (k: string) => void;
  setEmbeddingModel: (m: string) => void;
  setEmbeddingVolcMultimodal: (v: boolean) => void;
  /** 供 IPC 调用；未配置或 off 时返回 null */
  getEmbedConfigForIpc: () => KnowledgeEmbedConfig | null;
}

function defaultUrlForProvider(p: EmbeddingProviderKey): string {
  if (p === 'ollama') return DEFAULT_OLLAMA_URL;
  if (p === 'openai') return DEFAULT_OPENAI_URL;
  return DEFAULT_OPENAI_URL;
}

function defaultModelForProvider(p: EmbeddingProviderKey): string {
  if (p === 'ollama') return 'nomic-embed-text';
  if (p === 'openai') return 'text-embedding-3-small';
  return 'text-embedding-3-small';
}

export const useKnowledgeStore = create<KnowledgeStore>()(
  persist(
    (set, get) => ({
      vectorRagEnabled: false,
      vectorTopK: 5,
      ragMaxInjectChars: 8000,
      embeddingProvider: 'off',
      embeddingApiUrl: DEFAULT_OPENAI_URL,
      embeddingApiKey: '',
      embeddingModel: 'text-embedding-3-small',
      embeddingVolcMultimodal: false,
      setVectorRagEnabled: (v) => set({ vectorRagEnabled: v }),
      setVectorTopK: (n) => set({ vectorTopK: Math.min(12, Math.max(1, Math.floor(n) || 5)) }),
      setRagMaxInjectChars: (n) =>
        set({ ragMaxInjectChars: Math.min(30_000, Math.max(1000, Math.floor(n) || 8000)) }),
      setEmbeddingProvider: (p) =>
        set((state) => ({
          embeddingProvider: p,
          embeddingApiUrl: p === 'off' ? state.embeddingApiUrl : defaultUrlForProvider(p),
          embeddingModel: p === 'off' ? state.embeddingModel : defaultModelForProvider(p),
        })),
      setEmbeddingApiUrl: (u) => set({ embeddingApiUrl: u }),
      setEmbeddingApiKey: (k) => set({ embeddingApiKey: k }),
      setEmbeddingModel: (m) => set({ embeddingModel: m }),
      setEmbeddingVolcMultimodal: (v) => set({ embeddingVolcMultimodal: v }),
      getEmbedConfigForIpc: () => {
        const s = get();
        if (s.embeddingProvider === 'off') return null;
        const baseUrl = s.embeddingApiUrl.trim() || defaultUrlForProvider(s.embeddingProvider);
        const model = s.embeddingModel.trim() || defaultModelForProvider(s.embeddingProvider);
        const looksArk = /volces\.com|ark\.cn-/i.test(baseUrl);
        const nameSuggestsVision = /embedding-vision/i.test(model);
        const volcMultimodal =
          s.embeddingProvider === 'openai' &&
          (s.embeddingVolcMultimodal || (nameSuggestsVision && looksArk));
        return {
          provider: s.embeddingProvider,
          baseUrl,
          apiKey: s.embeddingApiKey || undefined,
          model,
          volcMultimodal: volcMultimodal || undefined,
        };
      },
    }),
    {
      name: 'knowledge-storage',
      version: 2,
      storage: zustandPersistJson,
    }
  )
);
