import { describe, expect, it } from 'vitest';
import { inferImageCountFromText, planImageIntent } from './imageIntentPlanner';
import type { Message } from '../types';

const msg = (content: string): Message => ({
  id: Math.random().toString(36),
  role: 'user',
  content,
  timestamp: Date.now(),
  model: 'test',
});

describe('imageIntentPlanner', () => {
  it('识别口语中文数量', () => {
    expect(inferImageCountFromText('重新生4张内衣模特展示图')).toBe(4);
    expect(inferImageCountFromText('生成九张不同风格不同款式')).toBe(9);
    expect(inferImageCountFromText('船上所有伙伴的相同风格图片，每人一张')).toBe(8);
  });

  it('识别继续生成并继承上一轮生图上下文', () => {
    const history = [
      msg('按照之前的淘宝比基尼模特图，生成九张不同风格不同款式的模特展示图'),
    ];
    const intent = planImageIntent({
      userText: '重新生4张，模特年轻一点',
      historyBeforeUser: history,
    });
    expect(intent.shouldGenerate).toBe(true);
    expect(intent.count).toBe(4);
    expect(intent.prompt).toContain('上一轮生图需求');
    expect(intent.prompt).toContain('模特年轻一点');
  });

  it('非图片请求不触发生图', () => {
    const intent = planImageIntent({
      userText: '解释一下刚才为什么失败',
      historyBeforeUser: [],
    });
    expect(intent.shouldGenerate).toBe(false);
  });

  it('助手建议图片展示但用户未要求时不触发生图', () => {
    const intent = planImageIntent({
      userText: '用表格列出这些数据',
      assistantText: '我可以用图片展示，也可以用表格展示。',
      historyBeforeUser: [],
    });
    expect(intent.shouldGenerate).toBe(false);
  });

  it('普通修改文字不继承上一轮生图', () => {
    const intent = planImageIntent({
      userText: '改成表格展示',
      historyBeforeUser: [msg('生成九张淘宝模特展示图')],
    });
    expect(intent.shouldGenerate).toBe(false);
  });

  it('泛化识别全员逐个出图，不依赖具体角色名单', () => {
    const intent = planImageIntent({
      userText: '我想要的是船上所有伙伴的相同风格图片，每人一张',
      historyBeforeUser: [],
    });
    expect(intent.shouldGenerate).toBe(true);
    expect(intent.count).toBe(8);
  });

  it('文本修订不被上一轮生图上下文劫持', () => {
    const intent = planImageIntent({
      userText: '不是图片，改成 Markdown 清单',
      historyBeforeUser: [msg('生成九张不同风格不同款式的模特展示图')],
    });
    expect(intent.shouldGenerate).toBe(false);
  });
});
