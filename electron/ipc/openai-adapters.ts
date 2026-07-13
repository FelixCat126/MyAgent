import fs from 'fs';
import { Message } from '../../src/types';

function normalizeTextContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
        if (obj.image_url || obj.inline_data || obj.source) return '（历史图片附件已省略）';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return raw == null ? '' : String(raw);
}

export function imageFileToDataUrl(file: NonNullable<Message['files']>[number]): string {
  if (file.preview && file.preview.startsWith('data:')) {
    return file.preview;
  }
  const p = file.path;
  if (!p || !fs.existsSync(p)) {
    throw new Error(
      `附件图片在本地已找不到（可能位于临时目录已被清理）：${p || '（无路径）'}。请重新上传图片后再发送。`
    );
  }
  const base64 = fs.readFileSync(p, { encoding: 'base64' });
  const mime = file.type && file.type.startsWith('image/') ? file.type : 'image/png';
  return `data:${mime};base64,${base64}`;
}

export function messagesHaveImageFiles(messages: Message[]): boolean {
  return messages.some((m) => m.files?.some((f) => f.type.startsWith('image/')));
}

export function errorIndicatesImageUnsupported(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: unknown } };
  const blob = `${e?.message ?? ''} ${JSON.stringify(e?.response?.data ?? '')}`.toLowerCase();
  return (
    blob.includes('do not support image') ||
    blob.includes('not support image') ||
    blob.includes('image input') ||
    (blob.includes('不支持') && (blob.includes('image') || blob.includes('图片') || blob.includes('vision'))) ||
    (blob.includes('multimodal') && blob.includes('not'))
  );
}

export function formatOpenAITextOnly(messages: Message[]): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    const hadImage = msg.files?.some((f) => f.type.startsWith('image/'));
    let content = normalizeTextContent((msg as { content?: unknown }).content);
    if (hadImage && !content.trim()) {
      content = '（附件）';
    }
    return { role: msg.role, content };
  });
}

export function formatOpenAIMultimodal(
  messages: Message[]
): Array<
  | { role: string; content: string }
  | { role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }
> {
  return messages.map((msg) => {
    const text = normalizeTextContent((msg as { content?: unknown }).content);
    if (msg.role === 'user' && msg.files && msg.files.some((f) => f.type.startsWith('image/'))) {
      const imageFile = msg.files.find((f) => f.type.startsWith('image/'))!;
      const dataUrl = imageFileToDataUrl(imageFile);
      return {
        role: msg.role,
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      };
    }
    return { role: msg.role, content: text };
  });
}

export function isZhipuEndpoint(apiUrl: string, modelName: string): boolean {
  return apiUrl.includes('bigmodel.cn') || modelName.toLowerCase().startsWith('glm-');
}

import {
  looksLikeMiniMaxChat,
  resolveAnthropicMessagesUrl,
} from '../../src/utils/chatApiMode';

/** @deprecated 使用 looksLikeMiniMaxChat；保留别名兼容旧调用 */
export function isMiniMaxChatEndpoint(apiUrl: string, modelName: string): boolean {
  return looksLikeMiniMaxChat(apiUrl, modelName);
}

/** @deprecated 使用 resolveAnthropicMessagesUrl */
export function resolveMiniMaxAnthropicMessagesUrl(apiUrl: string): string {
  return resolveAnthropicMessagesUrl(apiUrl);
}

export { resolveAnthropicMessagesUrl, looksLikeMiniMaxChat };

/** Anthropic Messages：拆出 system，其余为 user/assistant（含可选图片 / 思考块） */
export function formatAnthropicMessages(messages: Message[]): {
  system: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
} {
  let system = '';
  const out: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const t = normalizeTextContent((msg as { content?: unknown }).content);
      system = system ? `${system}\n${t}` : t;
      continue;
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = normalizeTextContent((msg as { content?: unknown }).content);
    if (msg.role === 'user' && msg.files?.some((f) => f.type.startsWith('image/'))) {
      const imageFile = msg.files.find((f) => f.type.startsWith('image/'))!;
      const dataUrl = imageFileToDataUrl(imageFile);
      const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1]! : dataUrl;
      const mediaType =
        imageFile.type && imageFile.type.startsWith('image/') ? imageFile.type : 'image/png';
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: text || '（空）' },
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: b64 },
          },
        ],
      });
      continue;
    }
    /** MiniMax 多轮要求保留 thinking 块；有 reasoning 时按 content 数组回传 */
    if (msg.role === 'assistant') {
      const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning.trim() : '';
      if (reasoning) {
        out.push({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: reasoning },
            { type: 'text', text: text || '' },
          ],
        });
        continue;
      }
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text: text || '' }],
      });
      continue;
    }
    out.push({
      role: 'user',
      content: [{ type: 'text', text: text || '（空）' }],
    });
  }
  return { system, messages: out };
}

/**
 * 生成「开启思考模式」的厂商请求参数（OpenAI 兼容 /chat/completions 路径）。
 * Anthropic Messages 路径请用 buildAnthropicThinkingParams（见 chatApiMode.ts）。
 */
export function buildThinkingParams(opts?: {
  apiUrl?: string;
  modelName?: string;
  stream?: boolean;
}): Record<string, unknown> {
  if (isMiniMaxChatEndpoint(opts?.apiUrl ?? '', opts?.modelName ?? '')) {
    return {
      thinking: { type: 'adaptive' },
      reasoning_split: true,
    };
  }
  return {
    enable_thinking: true,
    thinking: 'enabled',
    reasoning_effort: 'medium',
  };
}

export { resolveOpenAiCompatibleBaseUrl } from '../../src/utils/openAiCompatBase';
