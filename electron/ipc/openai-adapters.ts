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

/**
 * 生成「开启思考模式」的厂商通用请求参数。
 *
 * 各厂商的思考开关参数不同，但不支持思考的模型会忽略未知字段（OpenAI 兼容协议特性），
 * 因此可以无条件全部带上，一套代码覆盖所有厂商，无需按模型名硬编码判断。
 *
 * - Qwen3 / 通义千问：`enable_thinking: true`
 * - Doubao / 豆包（方舟）：`thinking: "enabled"`（字符串，非对象）
 * - DeepSeek：默认开启，无需参数（带上也无害）
 * - OpenAI o 系列：`reasoning_effort: "medium"`（非 o 系列忽略）
 * - Gemma / 普通 Llama：不支持，忽略未知字段
 *
 * 注：Claude 走独立路径（model.ts 的 Claude 分支），用的是
 * `thinking: { type: "enabled", budget_tokens: N }` 对象格式，不经过此函数。
 */
export function buildThinkingParams(): Record<string, unknown> {
  return {
    enable_thinking: true,
    thinking: 'enabled',
    reasoning_effort: 'medium',
  };
}

export { resolveOpenAiCompatibleBaseUrl } from '../../src/utils/openAiCompatBase';
