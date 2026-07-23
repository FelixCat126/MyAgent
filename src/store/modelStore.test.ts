import { beforeEach, describe, expect, it } from 'vitest';
import { useModelStore } from './modelStore';
import type { ModelConfig } from '../types';
import { PERSIST_KEYS } from '../utils/persistKeys';
import { BUILTIN_ROUTING_RULES, type RoutingRule } from '../agent/modelRouting';

function resetModelStore() {
  localStorage.removeItem(PERSIST_KEYS.model);
  useModelStore.setState({ models: [], activeModelId: null, routingRules: [] });
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

  it('initializeDefaultModels 在无模型时注入默认 Ollama', () => {
    useModelStore.getState().initializeDefaultModels();
    const st = useModelStore.getState();
    expect(st.models.length).toBe(3);
    expect(st.activeModelId).toBe(st.models[0].id);
  });

  it('列表为空时重新注入默认', () => {
    useModelStore.setState({ models: [], activeModelId: null });
    useModelStore.getState().initializeDefaultModels();
    expect(useModelStore.getState().models.length).toBe(3);
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
    useModelStore.setState({ models: [], activeModelId: 'nope' });
    expect(useModelStore.getState().getActiveModel()).toBeNull();
  });

  it('addModel 不重复填充同名 id 时插入末尾', () => {
    useModelStore.setState({ models: [oneModel('a')] });
    useModelStore.getState().addModel(oneModel('b'));
    expect(useModelStore.getState().models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(useModelStore.getState().activeModelId).toBe('b');
  });

  it('updateModel 改不存在 id 是 no-op', () => {
    useModelStore.getState().addModel(oneModel('a'));
    useModelStore.getState().updateModel('ghost', { modelName: 'x' });
    expect(useModelStore.getState().models[0].modelName).toBe('m');
  });

  it('setActiveModel 已知 id 切换；未知 id 忽略', () => {
    useModelStore.getState().addModel(oneModel('a'));
    useModelStore.getState().addModel(oneModel('b'));
    useModelStore.getState().setActiveModel('b');
    expect(useModelStore.getState().activeModelId).toBe('b');
    useModelStore.getState().setActiveModel('ghost');
    expect(useModelStore.getState().activeModelId).toBe('b');
  });

  it('removeModel 删非 active 时 active 不变', () => {
    useModelStore.getState().addModel(oneModel('a'));
    useModelStore.getState().addModel(oneModel('b'));
    useModelStore.getState().setActiveModel('a');
    useModelStore.getState().removeModel('b');
    expect(useModelStore.getState().activeModelId).toBe('a');
  });

  it('setImageGenModel 存到 imageGenModelId 字段', () => {
    useModelStore.getState().addModel(oneModel('a'));
    useModelStore.getState().setImageGenModel('a');
    expect(useModelStore.getState().imageGenModelId).toBe('a');
    useModelStore.getState().setImageGenModel(null);
    expect(useModelStore.getState().imageGenModelId).toBeNull();
  });

  it('getEffectiveImageGenModel 优先 imageGenModelId 否则自动找第一个 image tool 模型', () => {
    const noImg = { ...oneModel('text-only') };
    const withImg: ModelConfig = {
      ...oneModel('img-1'),
      isImageGenerator: true,
      imageGeneratorConfig: {
        type: 'http',
        endpoint: 'https://x',
      },
    };
    useModelStore.setState({ models: [noImg, withImg], activeModelId: 'text-only' });
    expect(useModelStore.getState().getEffectiveImageGenModel()?.id).toBe('img-1');
    useModelStore.getState().setImageGenModel('text-only');
    /** text-only 没 image tool，effective 应回退到 img-1（实现校验 modelHasUsableImageGenerator） */
    expect(useModelStore.getState().getEffectiveImageGenModel()?.id).toBe('img-1');
    useModelStore.getState().setImageGenModel('img-1');
    expect(useModelStore.getState().getEffectiveImageGenModel()?.id).toBe('img-1');
  });

  it('getEffectiveImageGenModel 无可用 image tool 时返回 undefined', () => {
    useModelStore.setState({ models: [oneModel('text-only')], activeModelId: 'text-only' });
    expect(useModelStore.getState().getEffectiveImageGenModel()).toBeUndefined();
  });

  it('setRoutingRules 覆盖整个数组', () => {
    const newRules: RoutingRule[] = [
      { id: 'r1', description: '', enabled: true, match: { kind: 'code' }, preferModelId: 'x' },
    ];
    useModelStore.getState().setRoutingRules(newRules);
    expect(useModelStore.getState().routingRules).toEqual(newRules);
  });

  it('routingRules 初值空数组', () => {
    expect(useModelStore.getState().routingRules).toEqual([]);
  });
});

describe('modelStore 持久化迁移', () => {
  it('v2 → v3 老数据无 routingRules 时补空数组', () => {
    const v2 = { models: [oneModel('a')], activeModelId: 'a' };
    useModelStore.setState({ ...v2, routingRules: [] });
    expect(useModelStore.getState().routingRules).toEqual([]);
  });

  it('持久化 v2 → v3 后写入 builtin 规则不影响', () => {
    /** BUILTIN_ROUTING_RULES 的 preferModelId 始终空，规则本身仍可持久化 */
    useModelStore.getState().setRoutingRules(BUILTIN_ROUTING_RULES);
    expect(useModelStore.getState().routingRules.length).toBe(3);
  });
});
