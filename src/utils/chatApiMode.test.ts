import { describe, expect, it } from 'vitest';
import {
  buildAnthropicAuthHeaders,
  buildAnthropicThinkingParams,
  resolveAnthropicMessagesUrl,
  resolveChatApiMode,
} from './chatApiMode';

describe('resolveChatApiMode', () => {
  it('显式 openai / anthropic 优先', () => {
    expect(
      resolveChatApiMode({
        chatApiMode: 'openai',
        apiUrl: 'https://api.minimaxi.com/v1',
        modelName: 'MiniMax-M3',
      })
    ).toBe('openai');
    expect(
      resolveChatApiMode({
        chatApiMode: 'anthropic',
        apiUrl: 'https://api.openai.com/v1',
        modelName: 'gpt-4o',
      })
    ).toBe('anthropic');
  });

  it('auto：MiniMax / anthropic URL / claude → anthropic', () => {
    expect(
      resolveChatApiMode({
        chatApiMode: 'auto',
        apiUrl: 'https://api.minimaxi.com/v1',
        modelName: 'MiniMax-M3',
      })
    ).toBe('anthropic');
    expect(
      resolveChatApiMode({
        apiUrl: 'https://api.minimax.io/anthropic/v1/messages',
        modelName: 'x',
      })
    ).toBe('anthropic');
    expect(resolveChatApiMode({ provider: 'claude', apiUrl: 'https://api.anthropic.com' })).toBe(
      'anthropic'
    );
  });

  it('auto：普通 OpenAI → openai', () => {
    expect(
      resolveChatApiMode({
        apiUrl: 'https://api.openai.com/v1',
        modelName: 'gpt-4o',
      })
    ).toBe('openai');
  });
});

describe('resolveAnthropicMessagesUrl', () => {
  it('MiniMax 映射到 /anthropic/v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://api.minimaxi.com/v1')).toBe(
      'https://api.minimaxi.com/anthropic/v1/messages'
    );
    expect(resolveAnthropicMessagesUrl('https://api.minimax.io/v1/chat/completions')).toBe(
      'https://api.minimax.io/anthropic/v1/messages'
    );
  });

  it('官方 Claude 映射到 /v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
  });
});

describe('Anthropic headers / thinking', () => {
  it('Claude 用 x-api-key，MiniMax 用 Bearer', () => {
    expect(buildAnthropicAuthHeaders({ apiKey: 'k', provider: 'claude' })['x-api-key']).toBe('k');
    expect(
      buildAnthropicAuthHeaders({
        apiKey: 'k',
        provider: 'custom',
        apiUrl: 'https://api.minimaxi.com/v1',
      }).Authorization
    ).toBe('Bearer k');
  });

  it('Claude thinking=enabled，MiniMax 仅用 adaptive（Anthropic 枚举无 enabled）', () => {
    expect(
      buildAnthropicThinkingParams({ provider: 'claude', maxTokens: 4096 }).thinking.type
    ).toBe('enabled');
    expect(
      buildAnthropicThinkingParams({
        apiUrl: 'https://api.minimaxi.com/v1',
        modelName: 'MiniMax-M3',
      }).thinking
    ).toEqual({ type: 'adaptive' });
  });
});
