import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const { geminiGenerateContentUrl } = await import('./model');

describe('geminiGenerateContentUrl', () => {
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  it('补上 models/ 前缀', () => {
    expect(geminiGenerateContentUrl(base, 'gemini-2.0-flash')).toBe(`${base}/models/gemini-2.0-flash:generateContent`);
  });
  it('模型名已带前缀或基址以 /models 结尾时不重复', () => {
    expect(geminiGenerateContentUrl(`${base}/`, 'models/gemini-2.0-flash')).toBe(`${base}/models/gemini-2.0-flash:generateContent`);
    expect(geminiGenerateContentUrl(`${base}/models`, 'models/gemini-2.0-flash')).toBe(`${base}/models/gemini-2.0-flash:generateContent`);
  });
});
