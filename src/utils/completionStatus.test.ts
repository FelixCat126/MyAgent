import { expect, it } from 'vitest';
import { completionWasTruncated } from './completionStatus';
it('recognizes OpenAI, Anthropic stream/sync and Gemini output limits', () => {
  for (const result of [{ choices: [{ finish_reason: 'length' }] }, { delta: { stop_reason: 'max_tokens' } }, { stop_reason: 'max_tokens' }, { candidates: [{ finishReason: 'MAX_TOKENS' }] }]) expect(completionWasTruncated(result)).toBe(true);
  for (const result of [null, {}, { choices: [{ finish_reason: 'stop' }] }, { stop_reason: 'end_turn' }]) expect(completionWasTruncated(result)).toBe(false);
});
