import { describe, expect, it } from 'vitest';
import { sanitizeMessagesForModel } from './sanitizeMessagesForModel';
import type { Message } from '../types';

const msg = (content: unknown, role: Message['role'] = 'assistant'): Message =>
  ({
    id: Math.random().toString(36),
    role,
    content,
    timestamp: Date.now(),
    model: 'test',
  }) as Message;

describe('sanitizeMessagesForModel', () => {
  it('移除历史助手消息里的 base64 图片内容数组', () => {
    const huge = `data:image/png;base64,${'A'.repeat(5000)}`;
    const out = sanitizeMessagesForModel([
      msg([
        { type: 'text', text: '说明' },
        { type: 'image_url', image_url: { url: huge } },
      ]),
    ]);
    expect(out[0].content).toContain('说明');
    expect(out[0].content).toContain('历史图片附件已省略');
    expect(out[0].content).not.toContain('base64');
    expect(JSON.stringify(out).length).toBeLessThan(500);
  });

  it('仅保留用户消息附件，避免助手历史附件重复进模型', () => {
    const files = [{ name: 'x.png', path: '/tmp/x.png', type: 'image/png', size: 1 }];
    const out = sanitizeMessagesForModel([
      { ...msg('assistant', 'assistant'), files },
      { ...msg('user', 'user'), files },
    ]);
    expect(out[0].files).toBeUndefined();
    expect(out[1].files).toEqual(files);
  });
});
