import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  buildConversationImageGallery,
  conversationGallerySlidesFromPaths,
  findConversationGalleryIndex,
} from './conversationImageGallery';

function msg(
  id: string,
  files: NonNullable<Message['files']>,
  timestamp = 0
): Message {
  return {
    id,
    role: 'user',
    content: '',
    timestamp,
    model: 'test',
    files,
  };
}

describe('buildConversationImageGallery（会话内可串联预览的图片列表）', () => {
  it('按消息时间顺序、每条消息内文件顺序收集 image/*', () => {
    const messages: Message[] = [
      msg('m1', [{ name: 'a.png', path: '/a.png', type: 'image/png', size: 1 }], 10),
      msg('m2', [{ name: 'b.txt', path: '/b.txt', type: 'text/plain', size: 1 }], 20),
      msg(
        'm3',
        [
          { name: 'c.png', path: '/c.png', type: 'image/png', size: 1 },
          { name: 'd.png', path: '/d.png', type: 'image/png', size: 1 },
        ],
        30
      ),
    ];
    const g = buildConversationImageGallery(messages);
    expect(g.map((x) => x.messageId)).toEqual(['m1', 'm3', 'm3']);
    expect(g.map((x) => x.fileIndex)).toEqual([0, 0, 1]);
    expect(g[0]!.defaultFileName).toBe('a.png');
    expect(g[0]!.localPath).toBe('/a.png');
    expect(g[0]!.src.startsWith('local-file:')).toBe(true);
  });

  it('有 data: 预览时 src 用 preview，仍要求 path 存在', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    const messages = [
      msg('u1', [
        { name: 'inline.png', path: '/p/inline.png', type: 'image/png', size: 1, preview: dataUrl },
      ]),
    ];
    const g = buildConversationImageGallery(messages);
    expect(g).toHaveLength(1);
    expect(g[0]!.src).toBe(dataUrl);
  });

  it('无 path 或无 displaySrc 的图片不进入图库', () => {
    const messages = [
      msg('x', [{ name: 'z.png', path: '', type: 'image/png', size: 0 }]),
      msg('y', [{ name: 'w.png', path: '/ok.png', type: 'image/png', size: 1 }]),
    ];
    const g = buildConversationImageGallery(messages);
    expect(g).toHaveLength(1);
    expect(g[0]!.messageId).toBe('y');
  });
});

describe('findConversationGalleryIndex', () => {
  it('按 messageId + fileIndex 定位', () => {
    const items = buildConversationImageGallery([
      msg('a', [
        { name: '1.png', path: '/1.png', type: 'image/png', size: 1 },
        { name: '2.png', path: '/2.png', type: 'image/png', size: 1 },
      ]),
    ]);
    expect(findConversationGalleryIndex(items, 'a', 1)).toBe(1);
    expect(findConversationGalleryIndex(items, 'a', 9)).toBe(-1);
  });
});

describe('conversationGallerySlidesFromPaths（图片库绝对路径列表）', () => {
  it('生成 __library__ 幻灯片并取 basename 为默认文件名', () => {
    const slides = conversationGallerySlidesFromPaths(['/Users/me/Pictures/out/shot.png']);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.messageId).toBe('__library__');
    expect(slides[0]!.fileIndex).toBe(0);
    expect(slides[0]!.defaultFileName).toBe('shot.png');
    expect(slides[0]!.localPath).toBe('/Users/me/Pictures/out/shot.png');
    expect(slides[0]!.src.startsWith('local-file:')).toBe(true);
  });

  it('支持 Windows 风格路径的 basename', () => {
    const slides = conversationGallerySlidesFromPaths(['C:\\\\a\\\\b\\\\c.jpg']);
    expect(slides[0]!.defaultFileName).toBe('c.jpg');
  });
});
