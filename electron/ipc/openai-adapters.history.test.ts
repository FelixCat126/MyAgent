// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Message } from '../../src/types';
import { formatAnthropicMessages, formatOpenAIMultimodal } from './openai-adapters';

const missing = { name: 'big.png', type: 'image/png', size: 900_000, path: '/nonexistent/myagent/big.png' };
const msg = (id: string, role: Message['role'], content: string, files?: Message['files']) =>
  ({ id, role, content, timestamp: 0, files }) as Message;

describe('历史图片附件丢失', () => {
  const history = [msg('1', 'user', '看图', [missing]), msg('2', 'assistant', '好的'), msg('3', 'user', '继续聊')];

  it('OpenAI 格式：历史缺图降级为文字，不阻断新消息', () => {
    const out = formatOpenAIMultimodal(history) as Array<{ content: unknown }>;
    expect(JSON.stringify(out[0].content)).toContain('已不在本地');
    expect(out[2].content).toBe('继续聊');
  });

  it('Anthropic 格式同样降级', () => {
    const out = formatAnthropicMessages(history);
    expect(JSON.stringify(out.messages[0].content)).toContain('已不在本地');
  });

  it('最新一条消息缺图仍明确报错', () => {
    expect(() => formatOpenAIMultimodal([msg('1', 'user', '看图', [missing])])).toThrow('找不到');
  });
});
