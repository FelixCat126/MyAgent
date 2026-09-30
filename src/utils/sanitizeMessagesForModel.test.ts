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

  it('附件型空助手转成非空占位，避免兼容接口卡在无正文历史轮次', () => {
    const files = [{ name: 'result.xlsx', path: '/tmp/result.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 1 }];
    const out = sanitizeMessagesForModel([
      { ...msg('第一问', 'user') },
      { ...msg('', 'assistant'), files },
      { ...msg('第二问', 'user') },
    ]);
    expect(out.map((item) => [item.role, item.content])).toEqual([
      ['user', '第一问'],
      ['assistant', '（上一轮助手已生成附件）'],
      ['user', '第二问'],
    ]);
    expect(out[1].files).toBeUndefined();
  });

  it('删除无正文无附件的空轮次，并合并由此相邻的同角色消息', () => {
    const out = sanitizeMessagesForModel([
      msg('问题一', 'user'),
      msg('   ', 'assistant'),
      msg('问题二', 'user'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('问题一\n\n问题二');
  });
});
