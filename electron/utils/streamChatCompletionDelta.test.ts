// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { extractContentAndReasoningFromSseDataLine } from './streamChatCompletionDelta';

describe('extractContentAndReasoningFromSseDataLine', () => {
  it('解析 DeepSeek 类 reasoning_content + content', () => {
    const line =
      'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: 'step A',
              content: '',
            },
          },
        ],
      });
    expect(extractContentAndReasoningFromSseDataLine(line)).toEqual({
      content: '',
      reasoning: 'step A',
    });
  });

  it('DONE 为空', () => {
    expect(extractContentAndReasoningFromSseDataLine('data: [DONE]')).toEqual({
      content: '',
      reasoning: '',
    });
  });
});
