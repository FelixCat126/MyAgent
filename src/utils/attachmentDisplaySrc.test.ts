import { describe, expect, it } from 'vitest';
import { attachmentImageDisplaySrc, isRemoteHttpUrl } from './attachmentDisplaySrc';

describe('attachmentDisplaySrc', () => {
  it('优先使用 data: preview', () => {
    expect(
      attachmentImageDisplaySrc({
        path: '/tmp/a.jpg',
        preview: 'data:image/jpeg;base64,abc',
      })
    ).toBe('data:image/jpeg;base64,abc');
  });

  it('支持 http(s) preview 与 path', () => {
    expect(
      attachmentImageDisplaySrc({
        path: 'https://cdn.example.com/a.jpg',
        preview: 'https://cdn.example.com/a.jpg',
      })
    ).toBe('https://cdn.example.com/a.jpg');
    expect(isRemoteHttpUrl('https://x.com/1.png')).toBe(true);
    expect(isRemoteHttpUrl('/tmp/a.png')).toBe(false);
  });
});
