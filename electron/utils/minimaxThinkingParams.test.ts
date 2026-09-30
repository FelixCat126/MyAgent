import { describe, expect, it } from 'vitest';
import {
  buildThinkingParams,
  formatAnthropicMessages,
  isMiniMaxChatEndpoint,
} from '../ipc/openai-adapters';
import type { Message } from '../../src/types';

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

  it('智谱 / glm-* 使用 thinking 对象，不混传 enable_thinking', () => {
    const byHost = buildThinkingParams({
      apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
      modelName: 'glm-4.7',
    });
    const byName = buildThinkingParams({
      apiUrl: 'https://example.com/v1',
      modelName: 'glm-4.7',
    });
    expect(byHost).toEqual({ thinking: { type: 'enabled' } });
    expect(byName).toEqual({ thinking: { type: 'enabled' } });
    expect(byHost.enable_thinking).toBeUndefined();
    expect(byHost.reasoning_effort).toBeUndefined();
  });

  it('非 MiniMax / 非智谱仍用通用启发式参数', () => {
    const p = buildThinkingParams({
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen-plus',
    });
    expect(p.enable_thinking).toBe(true);
    expect(p.thinking).toBe('enabled');
  });

  it('仅在 MiniMax 路径显式要求时回传历史 thinking 块', () => {
    const history: Message[] = [
      {
        id: 'a',
        role: 'assistant',
        content: '答案',
        reasoning: '历史思考',
        timestamp: 1,
        model: 'test',
      },
    ];
    expect(formatAnthropicMessages(history).messages[0]?.content).toEqual([
      { type: 'text', text: '答案' },
    ]);
    expect(
      formatAnthropicMessages(history, { includeAssistantThinking: true }).messages[0]?.content
    ).toEqual([
      { type: 'thinking', thinking: '历史思考' },
      { type: 'text', text: '答案' },
    ]);
  });
});
