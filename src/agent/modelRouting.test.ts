/** 模型路由规则引擎 */
import { describe, it, expect } from 'vitest';
import {
  pickModelId,
  matchesRule,
  detectContainsCode,
  isLongContext,
  BUILTIN_ROUTING_RULES,
  type RoutingRule,
  type RouteContext,
} from './modelRouting';
import type { ModelConfig } from '../types/model';

function mk(id: string, name = id): ModelConfig {
  return {
    id,
    name,
    provider: 'openai',
    apiUrl: 'https://x',
    apiKey: '',
    modelName: 'gpt-4',
    isLocal: false,
    maxTokens: 4096,
    isImageGenerator: false,
  };
}

const models: ModelConfig[] = [mk('cheap'), mk('coder'), mk('vision')];

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    kind: 'chat',
    messagesLen: 1,
    hasImages: false,
    containsCode: false,
    averageMessageLen: 100,
    lastRole: 'user',
    ...over,
  };
}

describe('detectContainsCode', () => {
  it('最后一条是 user 含 ``` 时为 true', () => {
    expect(
      detectContainsCode([
        { role: 'assistant', content: 'a' },
        { role: 'user', content: '```js\nx' },
      ])
    ).toBe(true);
  });

  it('最后一条是 user 含 function/=> 时为 true', () => {
    expect(detectContainsCode([{ role: 'user', content: 'const f = (x) => x' }])).toBe(true);
  });

  it('最后一条是 assistant 时向后回溯到 user；找不到时为 false', () => {
    expect(detectContainsCode([{ role: 'assistant', content: '```' }])).toBe(false);
  });
});

describe('matchesRule', () => {
  const rule: RoutingRule = {
    id: 'r1',
    description: '',
    enabled: true,
    match: { kind: 'code', containsCode: true },
    preferModelId: 'coder',
  };
  it('kind 不匹配返回 false', () => {
    expect(matchesRule(rule, ctx({ kind: 'chat' }))).toBe(false);
  });
  it('disabled 永远不匹配', () => {
    expect(matchesRule({ ...rule, enabled: false }, ctx({ kind: 'code', containsCode: true }))).toBe(
      false
    );
  });
  it('全条件命中返回 true', () => {
    expect(matchesRule(rule, ctx({ kind: 'code', containsCode: true }))).toBe(true);
  });
});

describe('pickModelId', () => {
  it('空规则返回 null', () => {
    expect(pickModelId([], ctx(), models)).toBeNull();
  });
  it('首条命中即胜出', () => {
    const rules: RoutingRule[] = [
      { id: 'r1', description: '', enabled: true, match: { hasImages: true }, preferModelId: 'vision' },
      { id: 'r2', description: '', enabled: true, match: { hasImages: true }, preferModelId: 'cheap' },
    ];
    expect(pickModelId(rules, ctx({ hasImages: true }), models)).toBe('vision');
  });
  it('preferModelId 不存在则跳过', () => {
    const rules: RoutingRule[] = [
      { id: 'r1', description: '', enabled: true, match: { hasImages: true }, preferModelId: 'ghost' },
    ];
    expect(pickModelId(rules, ctx({ hasImages: true }), models)).toBeNull();
  });
  it('长上下文命中 cheap', () => {
    const rules: RoutingRule[] = BUILTIN_ROUTING_RULES.map((r) => ({
      ...r,
      preferModelId: r.match.kind === 'chat' && r.match.longContextAvgAtLeast ? 'cheap' : r.preferModelId,
    }));
    expect(
      pickModelId(
        rules,
        ctx({ messagesLen: 30, averageMessageLen: 1500 }),
        models
      )
    ).toBe('cheap');
  });
  it('含代码命中 coder', () => {
    const rules: RoutingRule[] = BUILTIN_ROUTING_RULES.map((r) => ({
      ...r,
      preferModelId: r.match.containsCode ? 'coder' : r.preferModelId,
    }));
    expect(pickModelId(rules, ctx({ kind: 'code', containsCode: true }), models)).toBe('coder');
  });
  it('含图片命中 vision', () => {
    const rules: RoutingRule[] = BUILTIN_ROUTING_RULES.map((r) => ({
      ...r,
      preferModelId: r.match.hasImages ? 'vision' : r.preferModelId,
    }));
    expect(pickModelId(rules, ctx({ hasImages: true }), models)).toBe('vision');
  });
});

describe('isLongContext', () => {
  it('默认阈值 1200：30 × 100 = 3000 满足；30 × 30 = 900 不满足', () => {
    expect(isLongContext(ctx({ messagesLen: 30, averageMessageLen: 100 }))).toBe(true);
    expect(isLongContext(ctx({ messagesLen: 30, averageMessageLen: 30 }))).toBe(false);
  });
});
