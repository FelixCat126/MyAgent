import { describe, expect, it } from 'vitest';
import {
  estimateInjectedPayloadOverheadChars,
  messagesExceedSanitizeLimit,
  shouldWarnPayloadNearLimit,
  isContextSummaryMessage,
  SANITIZE_MAX_CONTENT_CHARS,
} from '../chat/payloadBoundary';

describe('payloadBoundary', () => {
  it('注入开销按开关累加', () => {
    expect(estimateInjectedPayloadOverheadChars({})).toBe(0);
    expect(
      estimateInjectedPayloadOverheadChars({ webEnabled: true, ragLikely: true, workspaceLikely: true })
    ).toBe(12_000 + 24_000 + 40_000);
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
});
