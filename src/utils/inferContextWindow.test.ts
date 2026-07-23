import { describe, it, expect } from 'vitest';
import {
  inferContextWindowTokens,
  resolveContextSoftLimitChars,
  contextWindowTokensToSoftLimitChars,
  UNIFIED_CONTEXT_WINDOW_TOKENS,
  PRODUCT_CONTEXT_SOFT_LIMIT_CHARS,
} from './inferContextWindow';

describe('inferContextWindowTokens', () => {
  it('产品约定统一 1M（不分厂商分支）', () => {
    expect(UNIFIED_CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    expect(inferContextWindowTokens({ provider: 'openai', modelName: 'gpt-4o' })).toBe(1_000_000);
    expect(inferContextWindowTokens({ provider: 'anthropic', modelName: 'claude-3-opus' })).toBe(1_000_000);
    expect(inferContextWindowTokens({})).toBe(1_000_000);
    expect(inferContextWindowTokens()).toBe(1_000_000);
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
  it('PRODUCT_CONTEXT_SOFT_LIMIT_CHARS 等于 1M tokens × 2 chars/token', () => {
    expect(PRODUCT_CONTEXT_SOFT_LIMIT_CHARS).toBe(UNIFIED_CONTEXT_WINDOW_TOKENS * 2);
  });
});
