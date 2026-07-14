import type { Message } from '../types';
import { SANITIZE_MAX_CONTENT_CHARS } from '../chat/payloadBoundary';

const DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/gi;
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{2000,}={0,2}\b/g;

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
      .replace(DATA_IMAGE_RE, '（已省略历史图片数据）')
      .replace(LONG_BASE64_RE, '（已省略历史二进制数据）');
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
        if (obj.image_url || obj.inline_data || obj.source) return '（历史图片附件已省略）';
        return '';
      })
      .filter(Boolean);
    return parts.join('\n');
  }
  if (content == null) return '';
  return String(content);
}

export function sanitizeMessagesForModel(messages: Message[]): Message[] {
  return messages.map((msg) => {
    let content = normalizeContent((msg as { content?: unknown }).content).trim();
    if (content.length > SANITIZE_MAX_CONTENT_CHARS) {
      content = `${content.slice(0, SANITIZE_MAX_CONTENT_CHARS)}\n\n（历史消息过长，已截断）`;
    }
    return {
      ...msg,
      content,
      files: msg.role === 'user' ? msg.files : undefined,
    };
  });
}
