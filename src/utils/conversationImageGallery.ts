import { pathToFileURL } from 'url';
import type { Message } from '../types';

/** 当前会话内可串联预览的附件图片（按消息时间顺序、每则消息内文件顺序） */
export type ConversationImageGalleryItem = {
  messageId: string;
  fileIndex: number;
  src: string;
  localPath: string;
  defaultFileName: string;
};

export function buildConversationImageGallery(messages: Message[]): ConversationImageGalleryItem[] {
  const out: ConversationImageGalleryItem[] = [];
  for (const msg of messages) {
    if (!msg.files?.length) continue;
    msg.files.forEach((file, fileIndex) => {
      if (!file.type.startsWith('image/')) return;
      const hasPreview = file.preview && file.preview.startsWith('data:');
      const displaySrc = hasPreview
        ? file.preview!
        : file.path
          ? pathToFileURL(file.path).href.replace(/^file:/i, 'local-file:')
          : '';
      if (!displaySrc || !file.path) return;
      out.push({
        messageId: msg.id,
        fileIndex,
        src: displaySrc,
        localPath: file.path,
        defaultFileName: file.name,
      });
    });
  }
  return out;
}

export function findConversationGalleryIndex(
  items: ConversationImageGalleryItem[],
  messageId: string,
  fileIndex: number
): number {
  return items.findIndex((x) => x.messageId === messageId && x.fileIndex === fileIndex);
}

function fileBasename(abs: string): string {
  const s = abs.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 与本机路径列表组装成与会话预览相同结构的幻灯片条目 */
export function conversationGallerySlidesFromPaths(
  absolutePaths: string[]
): ConversationImageGalleryItem[] {
  return absolutePaths.map((absolutePath, fileIndex) => ({
    messageId: '__library__',
    fileIndex,
    src: pathToFileURL(absolutePath).href.replace(/^file:/i, 'local-file:'),
    localPath: absolutePath,
    defaultFileName: fileBasename(absolutePath),
  }));
}
