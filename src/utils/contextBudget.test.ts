import { describe, expect, it } from 'vitest';
import {
  UNIFIED_CONTEXT_WINDOW_TOKENS,
  PRODUCT_CONTEXT_SOFT_LIMIT_CHARS,
  inferContextWindowTokens,
  resolveContextSoftLimitChars,
} from './inferContextWindow';
import {
  CONTEXT_COMPRESS_RATIO,
  estimateSessionChars,
  estimateMessageChars,
  shouldCompressContext,
  splitMessagesForCompression,
  parseCompressionSummary,
  compressMessagesLocally,
  resolveContextProgressFullChars,
  buildCompressionPrompt,
  createContextSummaryMessage,
} from './contextBudget';
import type { Message } from '../types';

function msg(role: Message['role'], content: string, id?: string): Message {
  return {
    id: id ?? `${role}-${content.slice(0, 8)}-${Math.random()}`,
    role,
    content,
    timestamp: Date.now(),
    model: 't',
  };
}

describe('inferContextWindowTokens', () => {
  it('产品约定统一 1M 软上限', () => {
    expect(UNIFIED_CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    expect(PRODUCT_CONTEXT_SOFT_LIMIT_CHARS).toBe(2_000_000);
    expect(
      inferContextWindowTokens({
        apiUrl: 'https://api.minimaxi.com/v1',
        modelName: 'MiniMax-M3',
      })
    ).toBe(1_000_000);
    expect(inferContextWindowTokens({ provider: 'ollama', apiUrl: 'http://127.0.0.1:11434' })).toBe(
      1_000_000
    );
    expect(resolveContextSoftLimitChars(null)).toBe(2_000_000);
  });
});

describe('contextBudget', () => {
  it('压缩阈值为 95%', () => {
    expect(CONTEXT_COMPRESS_RATIO).toBe(0.95);
  });

  it('estimateSessionChars 含草稿与 reasoning', () => {
    expect(estimateSessionChars([msg('user', 'abcd'), msg('assistant', 'ef')], 'gh')).toBe(8);
    const withReason: Message = {
      ...msg('assistant', 'ab'),
      reasoning: 'cd',
    };
    expect(estimateMessageChars(withReason)).toBe(4);
    expect(estimateSessionChars([withReason], '')).toBe(4);
  });

  it('进度条满格对齐压缩触发线', () => {
    const soft = resolveContextSoftLimitChars(null);
    expect(resolveContextProgressFullChars(null)).toBe(Math.floor(soft * CONTEXT_COMPRESS_RATIO));
  });

  it('shouldCompressContext 按 1M 软上限与 95% 判断', () => {
    const soft = resolveContextSoftLimitChars(null);
    const short = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c'), msg('assistant', 'd')];
    expect(shouldCompressContext(short, '')).toBe(false);
    const longContent = 'x'.repeat(Math.floor(soft * 0.96));
    const long = [
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', longContent),
    ];
    expect(shouldCompressContext(long, '')).toBe(true);
    const under = [
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', 'x'.repeat(Math.floor(soft * 0.9))),
    ];
    expect(shouldCompressContext(under, '')).toBe(false);
  });

  it('splitMessagesForCompression 保留末尾', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}-` + 'y'.repeat(800), `id-${i}`)
    );
    const { older, recent, keepFromIndex } = splitMessagesForCompression(messages, 3000, 4, 20_000);
    expect(keepFromIndex).toBeGreaterThan(0);
    expect(older.length + recent.length).toBe(messages.length);
    expect(recent[recent.length - 1]?.id).toBe('id-19');
  });

  it('parseCompressionSummary 加前缀', () => {
    expect(parseCompressionSummary('你好')).toContain('【上下文摘要】');
    expect(parseCompressionSummary('【上下文摘要】\n已有')).toBe('【上下文摘要】\n已有');
  });

  it('compressMessagesLocally 产生带 meta 的摘要+近期', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(2000), `id-${i}`)
    );
    const out = compressMessagesLocally(messages, undefined, 20_000);
    expect(out).not.toBeNull();
    expect(out!.messages[0]?.content).toContain('【上下文摘要】');
    expect(out!.summaryMessage.meta?.kind).toBe('context-summary');
    expect(out!.messages.length).toBeLessThan(messages.length);
  });

  it('buildCompressionPrompt 支持 en', () => {
    const prompt = buildCompressionPrompt([msg('user', 'hello')], 'en');
    expect(prompt[0]?.content).toMatch(/compressor/i);
    expect(prompt[1]?.content).toMatch(/Compress the earlier/i);
  });

  it('createContextSummaryMessage 带 meta', () => {
    const m = createContextSummaryMessage('【上下文摘要】\nx', 'm');
    expect(m.meta?.kind).toBe('context-summary');
  });
});
