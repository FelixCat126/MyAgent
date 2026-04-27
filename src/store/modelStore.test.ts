import { beforeEach, describe, expect, it } from 'vitest';
import { useModelStore } from './modelStore';
import type { ModelConfig } from '../types';

function resetModelStore() {
  localStorage.removeItem('model-storage');
  useModelStore.setState({ models: [], activeModelId: null, isInitialized: false });
}

const oneModel = (id: string): ModelConfig => ({
  id,
  name: 'M',
  provider: 'openai',
  apiUrl: 'https://x',
  apiKey: 'k',
  modelName: 'm',
  isLocal: false,
  maxTokens: 1000,
});

describe('modelStore', () => {
  beforeEach(() => {
    resetModelStore();
  });

  it('initializeDefaultModels 仅在空且未初始化时注入默认 Ollama', () => {
    useModelStore.getState().initializeDefaultModels();
    const st = useModelStore.getState();
    expect(st.models.length).toBe(3);
    expect(st.isInitialized).toBe(true);
    expect(st.activeModelId).toBe(st.models[0].id);
  });

  it('已有模型时 initialize 不覆盖', () => {
    useModelStore.getState().addModel(oneModel('custom-1'));
    useModelStore.getState().initializeDefaultModels();
    expect(useModelStore.getState().models).toHaveLength(1);
  });

  it('addModel 会设首模型为 active', () => {
    useModelStore.getState().addModel(oneModel('a'));
    expect(useModelStore.getState().activeModelId).toBe('a');
  });

  it('removeModel 会切换 active 到剩余第一个', () => {
    useModelStore.getState().addModel(oneModel('a'));
    useModelStore.getState().addModel({ ...oneModel('b'), name: 'B' });
    useModelStore.getState().setActiveModel('b');
    useModelStore.getState().removeModel('b');
    expect(useModelStore.getState().activeModelId).toBe('a');
  });

  it('removeModel 删到空时 active 为 null', () => {
    useModelStore.getState().addModel(oneModel('only'));
    useModelStore.getState().removeModel('only');
    expect(useModelStore.getState().activeModelId).toBeNull();
  });

  it('updateModel 合并字段', () => {
    useModelStore.getState().addModel(oneModel('a'));
    useModelStore.getState().updateModel('a', { modelName: 'new' });
    expect(useModelStore.getState().models[0].modelName).toBe('new');
  });

  it('getActiveModel 无匹配返回 null', () => {
    useModelStore.setState({ models: [], activeModelId: 'nope', isInitialized: true });
    expect(useModelStore.getState().getActiveModel()).toBeNull();
  });
});
