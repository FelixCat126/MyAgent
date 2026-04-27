import { describe, expect, it } from 'vitest';
import { getWebSearchQueryIfTriggered } from './webSearchTrigger';

describe('getWebSearchQueryIfTriggered', () => {
  it('空串与仅附件占位返回 null', () => {
    expect(getWebSearchQueryIfTriggered('')).toBeNull();
    expect(getWebSearchQueryIfTriggered('  \t  ')).toBeNull();
    expect(getWebSearchQueryIfTriggered('（附件）')).toBeNull();
  });

  it('明确不联网时返回 null（优先于句中「新闻」等关键词）', () => {
    expect(getWebSearchQueryIfTriggered('不要联网 随便说两句')).toBeNull();
    expect(getWebSearchQueryIfTriggered('不联网 说点别的')).toBeNull();
    expect(getWebSearchQueryIfTriggered('不要联网 今天新闻')).toBeNull();
  });

  it('强制前缀：去掉 /web、/联网、#联网 后取查询串', () => {
    expect(getWebSearchQueryIfTriggered('/web  北京天气')?.includes('北京')).toBe(true);
    expect(getWebSearchQueryIfTriggered('/联网 Rust 官方')).toContain('Rust');
    expect(getWebSearchQueryIfTriggered('#联网  测试')?.trim()).toBe('测试');
  });

  it('强制前缀后为空则 null', () => {
    expect(getWebSearchQueryIfTriggered('/web')).toBeNull();
    expect(getWebSearchQueryIfTriggered('/web  ')).toBeNull();
  });

  it('中文关键词命中', () => {
    const q = getWebSearchQueryIfTriggered('请帮我搜一下上海车展');
    expect(q).toBeTruthy();
    expect(q).toContain('上海');
  });

  it('英文关键词命中', () => {
    const q = getWebSearchQueryIfTriggered('Please google the weather in Paris');
    expect(q).toBeTruthy();
  });

  it('无关键词时返回 null', () => {
    expect(getWebSearchQueryIfTriggered('随便聊聊')).toBeNull();
  });

  it('命中关键词时去掉句首搜索口令（保留原句语义仍可从剩余串检索）', () => {
    const q = getWebSearchQueryIfTriggered('搜一下 特斯拉股价');
    expect(q).toBeTruthy();
  });

  it('查询串截断为 800 字符内', () => {
    const long = '搜索 ' + 'x'.repeat(1200);
    const q = getWebSearchQueryIfTriggered(long);
    expect(q).not.toBeNull();
    expect(q!.length).toBe(800);
  });
});
