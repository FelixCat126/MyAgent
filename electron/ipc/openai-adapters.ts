import fs from 'fs';
import { Message } from '../../src/types';

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
    let content = msg.content;
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
    if (msg.files && msg.files.some((f) => f.type.startsWith('image/'))) {
      const imageFile = msg.files.find((f) => f.type.startsWith('image/'))!;
      const dataUrl = imageFileToDataUrl(imageFile);
      return {
        role: msg.role,
        content: [
          { type: 'text', text: msg.content },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

export function isZhipuEndpoint(apiUrl: string, modelName: string): boolean {
  return apiUrl.includes('bigmodel.cn') || modelName.toLowerCase().startsWith('glm-');
}

export { resolveOpenAiCompatibleBaseUrl } from '../../src/utils/openAiCompatBase';
