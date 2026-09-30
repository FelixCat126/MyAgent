import { describe, it, expect } from 'vitest';
import {
  inferContextWindowTokens,
  resolveContextSoftLimitChars,
  contextWindowTokensToSoftLimitChars,
  UNIFIED_CONTEXT_WINDOW_TOKENS,
  PRODUCT_CONTEXT_SOFT_LIMIT_CHARS,
} from './inferContextWindow';

describe('inferContextWindowTokens', () => {
  it('未知模型采用保守预算', () => {
    expect(UNIFIED_CONTEXT_WINDOW_TOKENS).toBe(32_768);
    expect(inferContextWindowTokens({ provider: 'openai', modelName: 'gpt-4o' })).toBe(32_768);
    expect(inferContextWindowTokens({ provider: 'claude', modelName: 'claude-3-opus' })).toBe(32_768);
    expect(inferContextWindowTokens({})).toBe(32_768);
    expect(inferContextWindowTokens()).toBe(32_768);
  });

  it('自动识别当前长上下文模型，显式配置仍优先', () => {
    expect(inferContextWindowTokens({ provider: 'custom', modelName: 'MiniMax-M3' })).toBe(1_000_000);
    expect(inferContextWindowTokens({ provider: 'custom', apiUrl: 'https://api.kimi.com', modelName: 'k3' })).toBe(1_000_000);
    expect(inferContextWindowTokens({ provider: 'custom', modelName: 'k3-256k' })).toBe(262_144);
    expect(inferContextWindowTokens({ provider: 'custom', modelName: 'MiniMax-M3', contextWindowTokens: 200_000 })).toBe(200_000);
  });
});

describe('contextWindowTokensToSoftLimitChars', () => {
  it('tokens 低于 1024 时按 1024 计 → 2048 字符', () => {
    expect(contextWindowTokensToSoftLimitChars(1_000)).toBe(2_048);
    expect(contextWindowTokensToSoftLimitChars(100)).toBe(2_048);
  });
  it('tokens 2048 → 4096 字符', () => {
    expect(contextWindowTokensToSoftLimitChars(2_048)).toBe(4_096);
  });
});

describe('resolveContextSoftLimitChars', () => {
  it('返统一产品上限（字符）', () => {
    expect(resolveContextSoftLimitChars(null)).toBe(PRODUCT_CONTEXT_SOFT_LIMIT_CHARS);
    expect(resolveContextSoftLimitChars({ provider: 'openai', apiUrl: 'x', modelName: 'm' })).toBe(
      PRODUCT_CONTEXT_SOFT_LIMIT_CHARS
    );
  });
  it('输入预算预留输出长度', () => {
    expect(PRODUCT_CONTEXT_SOFT_LIMIT_CHARS).toBe((UNIFIED_CONTEXT_WINDOW_TOKENS - 4096) * 2);
  });
});

it('respects an explicit context window and reserves output', () => {
  expect(inferContextWindowTokens({ contextWindowTokens: 128000 })).toBe(128000);
  expect(resolveContextSoftLimitChars({ contextWindowTokens: 128000, maxTokens: 8000 })).toBe(240000);
  expect(inferContextWindowTokens({ provider: 'ollama' })).toBe(8192);
});
