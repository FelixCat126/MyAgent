import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../types';
import { filterSessionsByQuery } from './sessionFilter';

const base = (id: string, title: string, messages: { content: string }[]): ChatSession => ({
  id,
  title,
  messages: messages.map((m, i) => ({
    id: i + '',
    role: 'user' as const,
    content: m.content,
    timestamp: 1,
    model: 'm',
  })),
  createdAt: 1,
  updatedAt: 1,
});

describe('filterSessionsByQuery', () => {
  const sessions: ChatSession[] = [
    base('1', '工作笔记', [{ content: '项目 A' }]),
    base('2', '杂项', [{ content: '完全无关' }]),
  ];

  it('空查询返回原列表', () => {
    expect(filterSessionsByQuery(sessions, '')).toEqual(sessions);
    expect(filterSessionsByQuery(sessions, '  \t  ')).toEqual(sessions);
  });

  it('按标题匹配', () => {
    const r = filterSessionsByQuery(sessions, '工作');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('1');
  });

  it('按消息内容匹配', () => {
    const r = filterSessionsByQuery(sessions, '无关');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('2');
  });

  it('无匹配返回空数组', () => {
    expect(filterSessionsByQuery(sessions, '不存在的词')).toEqual([]);
  });

  it('不区分大小写', () => {
    const r = filterSessionsByQuery(sessions, '项目');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('1');
  });
});
