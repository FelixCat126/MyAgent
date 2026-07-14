import { describe, expect, it } from 'vitest';
import {
  estimateInjectedPayloadOverheadChars,
  messagesExceedSanitizeLimit,
  shouldWarnPayloadNearLimit,
  isContextSummaryMessage,
  SANITIZE_MAX_CONTENT_CHARS,
  ATTACH_DOCUMENT_MAX_TEXT_CHARS,
} from '../chat/payloadBoundary';
import { canPerformCompressionSplit, splitMessagesForCompression } from '../utils/contextBudget';
import type { Message } from '../types';

function msg(role: Message['role'], content: string, id?: string): Message {
  return {
    id: id ?? `${role}-${Math.random()}`,
    role,
    content,
    timestamp: Date.now(),
    model: 't',
  };
}

describe('payloadBoundary', () => {
  it('注入开销按开关累加', () => {
    expect(estimateInjectedPayloadOverheadChars({})).toBe(0);
    expect(
      estimateInjectedPayloadOverheadChars({
        webEnabled: true,
        ragLikely: true,
        workspaceLikely: true,
        ragMaxChars: 10_000,
        workspaceMaxChars: 8_000,
      })
    ).toBe(12_000 + 10_000 + 8_000);
  });

  it('sanitize 硬上限检测', () => {
    expect(messagesExceedSanitizeLimit([{ content: 'a'.repeat(10) }])).toBe(false);
    expect(
      messagesExceedSanitizeLimit([{ content: 'a'.repeat(SANITIZE_MAX_CONTENT_CHARS + 1) }])
    ).toBe(true);
  });

  it('payload 近限警告', () => {
    expect(
      shouldWarnPayloadNearLimit({
        storedChars: 1_000_000,
        injectedOverhead: 100_000,
        softLimitChars: 2_000_000,
      })
    ).toBe(false);
    expect(
      shouldWarnPayloadNearLimit({
        storedChars: 1_900_000,
        injectedOverhead: 50_000,
        softLimitChars: 2_000_000,
      })
    ).toBe(true);
  });

  it('识别上下文摘要', () => {
    expect(isContextSummaryMessage({ meta: { kind: 'context-summary' }, content: 'x' })).toBe(true);
    expect(isContextSummaryMessage({ content: '【上下文摘要】\nok' })).toBe(true);
    expect(isContextSummaryMessage({ content: '普通回复' })).toBe(false);
  });

  it('文档上限常量对齐 enrich', () => {
    expect(ATTACH_DOCUMENT_MAX_TEXT_CHARS).toBe(600_000);
  });
});

describe('compression split feasibility', () => {
  it('消息足够多时即使单条巨大也能切出 older', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(5000), `id-${i}`)
    );
    expect(canPerformCompressionSplit(messages, 20_000)).toBe(true);
    const { older } = splitMessagesForCompression(messages, undefined, 6, 20_000);
    expect(older.length).toBeGreaterThan(0);
  });
});
