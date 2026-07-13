import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ModelConfig, type ChatApiMode } from '../types';
import { resolveChatApiMode } from '../utils/chatApiMode';
import { zustandPersistJson } from '../utils/zustandFileStorage';

/**
 * 判断一个模型是否配置了可用的生图工具（HTTP endpoint 或 CLI command）。
 * 独立于对话模型：对话模型和生图模型可以是不同的 ModelConfig。
 */
export function modelHasUsableImageGenerator(m: ModelConfig | undefined | null): boolean {
  if (!m?.isImageGenerator || !m.imageGeneratorConfig) return false;
  const c = m.imageGeneratorConfig;
  if (c.type === 'http') return Boolean(String(c.endpoint ?? '').trim());
  return Boolean(String(c.command ?? '').trim());
}

/** 为旧配置推断并落盘显式接口模式（openai | anthropic） */
export function suggestPersistedChatApiMode(
  m: Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName' | 'chatApiMode'>
): Exclude<ChatApiMode, 'auto'> {
  return resolveChatApiMode({ ...m, chatApiMode: 'auto' });
}

function withSuggestedChatApiMode(m: ModelConfig): ModelConfig {
  if (m.chatApiMode === 'openai' || m.chatApiMode === 'anthropic') return m;
  return { ...m, chatApiMode: suggestPersistedChatApiMode(m) };
}

interface ModelStore {
  models: ModelConfig[];
  activeModelId: string | null;
  /** 独立生图模型 ID；null = 自动选择第一个可用的生图模型（向后兼容） */
  imageGenModelId: string | null;
  isInitialized: boolean;

  // Actions
  addModel: (config: ModelConfig) => void;
  removeModel: (id: string) => void;
  updateModel: (id: string, config: Partial<ModelConfig>) => void;
  setActiveModel: (id: string) => void;
  setImageGenModel: (id: string | null) => void;
  getActiveModel: () => ModelConfig | null;
  initializeDefaultModels: () => void;
  /** 生效的生图模型：优先 imageGenModelId，否则自动找第一个可用生图模型 */
  getEffectiveImageGenModel: () => ModelConfig | undefined;
}

// 默认 Ollama 模型配置
const defaultOllamaModels: ModelConfig[] = [
  {
    id: 'ollama-qwen3-vl-8b',
    name: 'Qwen3-VL 8B (本地)',
    provider: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    modelName: 'qwen3-vl:8b',
    chatApiMode: 'openai',
    isLocal: true,
    maxTokens: 8192,
  },
  {
    id: 'ollama-qwen3-vl-2b',
    name: 'Qwen3-VL 2B (本地)',
    provider: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    modelName: 'qwen3-vl:2b',
    chatApiMode: 'openai',
    isLocal: true,
    maxTokens: 8192,
  },
  {
    id: 'ollama-gemma4-26b',
    name: 'Gemma4 26B (本地)',
    provider: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    modelName: 'gemma4:26b',
    chatApiMode: 'openai',
    isLocal: true,
    maxTokens: 8192,
  },
];

export const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      models: [],
      activeModelId: null,
      imageGenModelId: null,
      isInitialized: false,

      initializeDefaultModels: () => {
        const { models } = get();
        /** 远端/桌面均需：只要列表为空就补默认本机候选，避免因「曾初始化后又删光」永远无法选模型 */
        if (models.length > 0) return;

        set({
          models: defaultOllamaModels,
          activeModelId: defaultOllamaModels[0]?.id || null,
          isInitialized: true,
        });
      },

      addModel: (config: ModelConfig) => {
        set((state: ModelStore) => ({
          models: [...state.models, withSuggestedChatApiMode(config)],
          activeModelId: state.activeModelId || config.id,
        }));
      },

      removeModel: (id: string) => {
        set((state: ModelStore) => {
          const newModels = state.models.filter((m: ModelConfig) => m.id !== id);
          return {
            models: newModels,
            activeModelId: state.activeModelId === id
              ? (newModels.length > 0 ? newModels[0].id : null)
              : state.activeModelId,
            /** 删除的恰好是生图模型 → 清空，回退到自动选择 */
            imageGenModelId: state.imageGenModelId === id ? null : state.imageGenModelId,
          };
        });
      },

      updateModel: (id: string, config: Partial<ModelConfig>) => {
        set((state: ModelStore) => ({
          models: state.models.map((m: ModelConfig) =>
            m.id === id ? withSuggestedChatApiMode({ ...m, ...config }) : m
          ),
        }));
      },

      setActiveModel: (id: string) => {
        set({ activeModelId: id });
      },

      setImageGenModel: (id: string | null) => {
        set({ imageGenModelId: id });
      },

      getActiveModel: () => {
        const { models, activeModelId } = get();
        return models.find((m: ModelConfig) => m.id === activeModelId) || null;
      },

      getEffectiveImageGenModel: () => {
        const { models, imageGenModelId } = get();
        /** 1) 显式选定的生图模型 */
        if (imageGenModelId) {
          const m = models.find((x) => x.id === imageGenModelId);
          if (m && modelHasUsableImageGenerator(m)) return m;
        }
        /** 2) 自动选择第一个配置了可用生图工具的模型 */
        return models.find((m) => modelHasUsableImageGenerator(m));
      },
    }),
    {
      name: 'model-storage',
      storage: zustandPersistJson,
      version: 1,
      migrate: (persistedState, fromVersion) => {
        const state = persistedState as {
          models?: ModelConfig[];
          activeModelId?: string | null;
          imageGenModelId?: string | null;
          isInitialized?: boolean;
        };
        if (!state || !Array.isArray(state.models)) return persistedState as typeof state;
        if (fromVersion < 1) {
          state.models = state.models.map((m) => withSuggestedChatApiMode(m));
        }
        return state;
      },
      onRehydrateStorage: () => (state) => {
        if (!state?.models?.length) return;
        const models = state.models.map((m) => withSuggestedChatApiMode(m));
        const changed = models.some((m, i) => m.chatApiMode !== state.models[i]?.chatApiMode);
        if (changed) {
          useModelStore.setState({ models });
        }
      },
    }
  )
);
