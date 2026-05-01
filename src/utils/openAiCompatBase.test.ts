import { describe, expect, it } from 'vitest';
import { resolveOpenAiCompatibleBaseUrl } from './openAiCompatBase';

describe('resolveOpenAiCompatibleBaseUrl', () => {
  it('Ollama 根地址自动补 /v1', () => {
    expect(resolveOpenAiCompatibleBaseUrl('http://127.0.0.1:11434', 'ollama')).toBe('http://127.0.0.1:11434/v1');
    expect(resolveOpenAiCompatibleBaseUrl('http://localhost:11434/', 'ollama')).toBe('http://127.0.0.1:11434/v1');
  });
  it('Ollama 将 localhost / IPv6 loopback 规范为 127.0.0.1', () => {
    expect(resolveOpenAiCompatibleBaseUrl('http://[::1]:11434', 'ollama')).toBe('http://127.0.0.1:11434/v1');
  });
  it('已含 v1 不重复', () => {
    expect(resolveOpenAiCompatibleBaseUrl('http://127.0.0.1:11434/v1', 'ollama')).toBe('http://127.0.0.1:11434/v1');
  });
  it('非 ollama 不改动', () => {
    expect(resolveOpenAiCompatibleBaseUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1');
  });
  it('带路径的反代不自动加 v1', () => {
    expect(resolveOpenAiCompatibleBaseUrl('https://proxy.example/llm', 'ollama')).toBe('https://proxy.example/llm');
  });
});
