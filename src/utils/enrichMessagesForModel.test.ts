import { describe, it, expect } from 'vitest';
import { enrichMessagesForModel } from './enrichMessagesForModel';
import type { Message } from '../types';

const msg = (partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message => ({
  timestamp: 0,
  model: '',
  ...partial,
});

describe('enrichMessagesForModel', () => {
  it('空 messages 数组返空', async () => {
    await expect(enrichMessagesForModel([])).resolves.toEqual([]);
  });

  it('单条 user 消息原样保留（无附件无需 enrich）', async () => {
    const m = msg({ id: 'm1', role: 'user', content: 'hi' });
    const out = await enrichMessagesForModel([m]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('m1');
    expect(out[0]!.content).toBe('hi');
  });

  it('保留全部合法角色消息', async () => {
    const msgs = [
      msg({ id: 'a', role: 'system', content: 'sys' }),
      msg({ id: 'b', role: 'user', content: 'hi' }),
      msg({ id: 'c', role: 'assistant', content: 'ok' }),
    ];
    const out = await enrichMessagesForModel(msgs);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});


it('uses the retained artifact body in follow-up model context', async () => {
  const message = { id: 'artifact', role: 'assistant' as const, content: '文件已生成', timestamp: 1, model: 'test', exportHint: { sourceContent: '# 完整报告\n\n不能丢失的原文' } };
  const result = await enrichMessagesForModel([message], 'zh');
  expect(result[0].content).toBe(message.exportHint.sourceContent);
});
