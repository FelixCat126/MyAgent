import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ModelConfig } from '../types';
import { zustandPersistJson } from '../utils/zustandFileStorage';

interface ModelStore {
  models: ModelConfig[];
  activeModelId: string | null;
  isInitialized: boolean;
  
  // Actions
  addModel: (config: ModelConfig) => void;
  removeModel: (id: string) => void;
  updateModel: (id: string, config: Partial<ModelConfig>) => void;
  setActiveModel: (id: string) => void;
  getActiveModel: () => ModelConfig | null;
  initializeDefaultModels: () => void;
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
    isLocal: true,
    maxTokens: 8192,
  },
];

export const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      models: [],
      activeModelId: null,
      isInitialized: false,

      initializeDefaultModels: () => {
        const { models } = get();
        /** 远端/桌面均需：只要列表为空就补默认本机候选，避免因「曾初始化但又删光」永远无法选模型 */
        if (models.length > 0) return;

        set({
          models: defaultOllamaModels,
          activeModelId: defaultOllamaModels[0]?.id || null,
          isInitialized: true,
        });
      },

      addModel: (config: ModelConfig) => {
        set((state: ModelStore) => ({
          models: [...state.models, config],
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
          };
        });
      },

      updateModel: (id: string, config: Partial<ModelConfig>) => {
        set((state: ModelStore) => ({
          models: state.models.map((m: ModelConfig) =>
            m.id === id ? { ...m, ...config } : m
          ),
        }));
      },

      setActiveModel: (id: string) => {
        set({ activeModelId: id });
      },

      getActiveModel: () => {
        const { models, activeModelId } = get();
        return models.find((m: ModelConfig) => m.id === activeModelId) || null;
      },
    }),
    {
      name: 'model-storage',
      storage: zustandPersistJson,
    }
  )
);
