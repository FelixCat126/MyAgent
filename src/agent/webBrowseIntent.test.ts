import { describe, expect, it } from 'vitest';
import {
  buildWebBrowseUrl,
  extractUrlFromUserText,
  isSimpleWebBrowseOnly,
  needsWebAgentWorkflow,
  parseWebBrowseIntent,
  resolveWebBrowseOpenUrl,
  userWantsWebPageDescription,
} from './webBrowseIntent';

describe('webBrowseIntent', () => {
  it('解析打开百度搜索', () => {
    const q = '打开百度，搜索"美女"';
    const intent = parseWebBrowseIntent(q);
    expect(intent).toEqual({ kind: 'baidu_search', query: '美女' });
    expect(buildWebBrowseUrl(intent!)).toBe('https://www.baidu.com/s?wd=%E7%BE%8E%E5%A5%B3');
  });

  it('识别「打开网站并说明是什么」但无 URL', () => {
    const q = '打开一个网站告诉我这是个什么网站';
    expect(userWantsWebPageDescription(q)).toBe(true);
    expect(extractUrlFromUserText(q)).toBeNull();
  });

  it('从话术中提取 URL', () => {
    expect(extractUrlFromUserText('打开 https://example.com 告诉我这是什么网站')).toBe(
      'https://example.com'
    );
    expect(extractUrlFromUserText('访问 github.com 介绍一下')).toBe('https://github.com');
  });

  it('解析打开百度首页', () => {
    expect(parseWebBrowseIntent('打开百度首页')).toEqual({
      kind: 'open_url',
      url: 'https://www.baidu.com/',
    });
  });

  it('非浏览请求返回 null', () => {
    expect(parseWebBrowseIntent('今天天气怎么样')).toBeNull();
  });

  it('多步取图请求：只提取引号内关键词，且不走简单快速路径', () => {
    const q = '打开百度，搜索"美女"，进入图片，然后把其中第一张图片返回给我';
    const intent = parseWebBrowseIntent(q);
    expect(intent).toEqual({ kind: 'baidu_search', query: '美女' });
    expect(isSimpleWebBrowseOnly(q, intent)).toBe(false);
    expect(needsWebAgentWorkflow(q)).toBe(true);
    expect(resolveWebBrowseOpenUrl(intent!, q)).toContain('image.baidu.com');
    expect(resolveWebBrowseOpenUrl(intent!, q)).toContain(encodeURIComponent('美女'));
  });

  it('「返回第一张」即使用户未说图片也走图片搜索 URL', () => {
    const q = '打开百度，搜索"美女"，返回第一张';
    const intent = parseWebBrowseIntent(q);
    expect(intent?.kind).toBe('baidu_search');
    expect(resolveWebBrowseOpenUrl(intent!, q)).toContain('image.baidu.com');
  });

  it('谷歌图片搜索走 tbm=isch', () => {
    const q = '打开谷歌搜索手表图片，返回第一张';
    const intent = parseWebBrowseIntent(q);
    expect(intent?.kind).toBe('google_search');
    const url = resolveWebBrowseOpenUrl(intent!, q);
    expect(url).toContain('tbm=isch');
    expect(url).toContain('google.com');
  });
});
