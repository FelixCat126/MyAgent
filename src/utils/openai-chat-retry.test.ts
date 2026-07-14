import { describe, expect, it, vi } from 'vitest';
import {
  canFallbackAnthropicToOpenAi,
  withOpenAiCompatibleFallbacks,
} from '../../electron/ipc/openai-chat-retry';
import type { ModelConfig } from '../types';

describe('openai-chat-retry', () => {
  it('canFallbackAnthropicToOpenAi：仅 auto 且非 claude', () => {
    expect(
      canFallbackAnthropicToOpenAi({
        provider: 'custom',
        chatApiMode: 'auto',
      } as ModelConfig)
    ).toBe(true);
    expect(
      canFallbackAnthropicToOpenAi({
        provider: 'custom',
        chatApiMode: 'anthropic',
      } as ModelConfig)
    ).toBe(false);
    expect(
      canFallbackAnthropicToOpenAi({
        provider: 'claude',
        chatApiMode: 'auto',
      } as ModelConfig)
    ).toBe(false);
  });

  it('withOpenAiCompatibleFallbacks：400 去掉思考参数重试', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce('ok');
    const out = await withOpenAiCompatibleFallbacks({
      messages: [],
      messagesHaveImages: false,
      errorIndicatesImageUnsupported: () => false,
      request,
    });
    expect(out).toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(['multimodal', true]);
    expect(request.mock.calls[1]).toEqual(['multimodal', false]);
  });
});
