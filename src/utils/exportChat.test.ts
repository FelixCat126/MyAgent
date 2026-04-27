import { describe, expect, it } from 'vitest';
import { ChatSession } from '../types';
import { sessionToHtml, sessionToMarkdown } from './exportChat';

function makeSession(overrides?: Partial<ChatSession>): ChatSession {
  return {
    id: 's1',
    title: '测试会话',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('sessionToMarkdown', () => {
  it('包含标题与角色分段', () => {
    const md = sessionToMarkdown(
      makeSession({
        messages: [
          {
            id: '1',
            role: 'user',
            content: '你好',
            timestamp: 1,
            model: 'm',
          },
          {
            id: '2',
            role: 'assistant',
            content: '您好',
            timestamp: 2,
            model: 'm',
          },
        ],
      })
    );
    expect(md).toContain('# 测试会话');
    expect(md).toContain('**用户**');
    expect(md).toContain('你好');
    expect(md).toContain('**助手**');
    expect(md).toContain('您好');
  });
});

describe('sessionToHtml', () => {
  it('转义标题与内容中的 HTML 特殊字符', () => {
    const html = sessionToHtml(
      makeSession({
        title: '<script>',
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'a & b',
            timestamp: 1,
            model: 'm',
          },
        ],
      })
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toMatch(/<!DOCTYPE html>/);
  });
});
