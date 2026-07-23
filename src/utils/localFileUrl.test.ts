import { describe, it, expect } from 'vitest';
import { pathToFileUrlHref, localFileProtocolUrl } from './localFileUrl';

describe('pathToFileUrlHref', () => {
  it('POSIX 绝对路径直接编码', () => {
    expect(pathToFileUrlHref('/a/b/c.png')).toBe('file:///a/b/c.png');
  });
  it('自动补前导斜杠', () => {
    expect(pathToFileUrlHref('a/b/c.png')).toBe('file:///a/b/c.png');
  });
  it('反斜杠 → 正斜杠', () => {
    expect(pathToFileUrlHref('C:/a%20b/c.png')).toBe('file:///C:/a%20b/c.png');
  });
  it('Windows 盘符前缀不编冒号', () => {
    expect(pathToFileUrlHref('C:/a/b.png')).toBe('file:///C:/a/b.png');
    expect(pathToFileUrlHref('D:/图/空 a.png')).toBe('file:///D:/%E5%9B%BE/%E7%A9%BA%20a.png');
  });
  it('空格 / CJK / # 段级 encodeURIComponent', () => {
    expect(pathToFileUrlHref('/图/空 a/#1.png')).toBe('file:///%E5%9B%BE/%E7%A9%BA%20a/%231.png');
  });
});

describe('localFileProtocolUrl', () => {
  it('file:// 转 local-file://', () => {
    expect(localFileProtocolUrl('/a/b.png')).toBe('local-file:///a/b.png');
  });
  it('大小写 FILE: 也替换（不区分大小写）', () => {
    expect(localFileProtocolUrl('/x').startsWith('local-file:')).toBe(true);
  });
});
