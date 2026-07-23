import { describe, it, expect } from 'vitest';
import { PERSIST_KEYS } from './persistKeys';

describe('PERSIST_KEYS', () => {
  it('所有键唯一', () => {
    const vals = Object.values(PERSIST_KEYS);
    expect(new Set(vals).size).toBe(vals.length);
  });
  it('键名符合 zustand persist 命名规则（带连字符的命名空间）', () => {
    for (const v of Object.values(PERSIST_KEYS)) {
      expect(v).toMatch(/^[a-z-]+$/);
    }
  });
  it('必含 chat / model / setting / web-search / knowledge / workspace', () => {
    const set = new Set(Object.values(PERSIST_KEYS));
    expect(set.has('chat-storage')).toBe(true);
    expect(set.has('model-storage')).toBe(true);
    expect(set.has('setting-storage')).toBe(true);
    expect(set.has('web-search-storage')).toBe(true);
    expect(set.has('knowledge-storage')).toBe(true);
    expect(set.has('workspace-storage')).toBe(true);
  });
});
