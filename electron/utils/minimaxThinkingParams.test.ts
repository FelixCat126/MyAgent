import { describe, expect, it } from 'vitest';
import {
  buildThinkingParams,
  isMiniMaxChatEndpoint,
} from '../ipc/openai-adapters';

describe('MiniMax 思考参数', () => {
  it('按 Endpoint / 模型名识别 MiniMax', () => {
    expect(isMiniMaxChatEndpoint('https://api.minimaxi.com/v1', 'MiniMax-M3')).toBe(true);
    expect(isMiniMaxChatEndpoint('https://api.minimax.io/v1', 'something')).toBe(true);
    expect(isMiniMaxChatEndpoint('https://api.openai.com/v1', 'MiniMax-M2.5')).toBe(true);
    expect(isMiniMaxChatEndpoint('https://api.openai.com/v1', 'gpt-4o')).toBe(false);
  });

  it('MiniMax 流式与非流式均使用 adaptive + reasoning_split', () => {
    const stream = buildThinkingParams({
      apiUrl: 'https://api.minimaxi.com/v1',
      modelName: 'MiniMax-M3',
      stream: true,
    });
    const nonStream = buildThinkingParams({
      apiUrl: 'https://api.minimaxi.com/v1',
      modelName: 'MiniMax-M3',
      stream: false,
    });
    expect(stream).toEqual({
      thinking: { type: 'adaptive' },
      reasoning_split: true,
    });
    expect(nonStream).toEqual(stream);
  });

  it('非 MiniMax 仍用通用参数', () => {
    const p = buildThinkingParams({
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen-plus',
    });
    expect(p.enable_thinking).toBe(true);
    expect(p.thinking).toBe('enabled');
  });
});
