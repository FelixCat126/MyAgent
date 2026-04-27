import { describe, expect, it } from 'vitest';
import { canUseSseStream, effectiveWebEnabled, isZhipuModel } from './chatModelPolicy';
import type { ChatSession, ModelConfig } from '../types';

function m(partial: Partial<ModelConfig> & Pick<ModelConfig, 'id' | 'provider' | 'apiUrl' | 'modelName'>): ModelConfig {
  return {
    name: 'n',
    isLocal: false,
    maxTokens: 1000,
    ...partial,
  } as ModelConfig;
}

describe('isZhipuModel', () => {
  it('智谱 host 或 glm 前缀', () => {
    expect(isZhipuModel(m({ id: '1', provider: 'custom', apiUrl: 'https://open.bigmodel.cn/xxx', modelName: 'x' }))).toBe(
      true
    );
    expect(isZhipuModel(m({ id: '1', provider: 'openai', apiUrl: 'https://x', modelName: 'GLM-4' }))).toBe(true);
  });
  it('非智谱为 false', () => {
    expect(isZhipuModel(m({ id: '1', provider: 'openai', apiUrl: 'https://api.openai.com', modelName: 'gpt-4' }))).toBe(
      false
    );
  });
});

describe('canUseSseStream', () => {
  it('openai / custom / ollama 为 true', () => {
    expect(canUseSseStream(m({ id: '1', provider: 'openai', apiUrl: 'u', modelName: 'g' }))).toBe(true);
    expect(canUseSseStream(m({ id: '1', provider: 'custom', apiUrl: 'u', modelName: 'g' }))).toBe(true);
    expect(canUseSseStream(m({ id: '1', provider: 'ollama', apiUrl: 'u', modelName: 'g' }))).toBe(true);
  });
  it('claude 仅当智谱判据时为 true，否则 false', () => {
    expect(canUseSseStream(m({ id: '1', provider: 'claude', apiUrl: 'u', modelName: 'c' }))).toBe(false);
    expect(
      canUseSseStream(
        m({ id: '1', provider: 'claude', apiUrl: 'https://open.bigmodel.cn', modelName: 'c' })
      )
    ).toBe(true);
  });
});

describe('effectiveWebEnabled', () => {
  it('无会话或 default 时跟全局', () => {
    expect(effectiveWebEnabled(undefined, true)).toBe(true);
    expect(effectiveWebEnabled(undefined, false)).toBe(false);
    expect(
      effectiveWebEnabled({ webSearchOverride: 'default' } as ChatSession, true)
    ).toBe(true);
  });
  it('on 强制开，off 强制关', () => {
    expect(effectiveWebEnabled({ webSearchOverride: 'on' } as ChatSession, false)).toBe(true);
    expect(effectiveWebEnabled({ webSearchOverride: 'off' } as ChatSession, true)).toBe(false);
  });
});
