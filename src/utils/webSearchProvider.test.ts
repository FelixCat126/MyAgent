import { describe, expect, it } from 'vitest';
import { normalizeWebSearchProvider } from './webSearchProvider';

describe('normalizeWebSearchProvider', () => {
  it('默认 duckduckgo', () => {
    expect(normalizeWebSearchProvider('')).toBe('duckduckgo');
    expect(normalizeWebSearchProvider('unknown')).toBe('duckduckgo');
  });
  it('识别 tavily / brave', () => {
    expect(normalizeWebSearchProvider('Tavily')).toBe('tavily');
    expect(normalizeWebSearchProvider('brave')).toBe('brave');
  });
});
