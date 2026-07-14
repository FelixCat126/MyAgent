import type { Message, ModelConfig } from '../../src/types';

/** Anthropic 失败时是否允许回退 OpenAI 兼容（仅 auto 推断，显式 anthropic/claude 不可回退） */
export function canFallbackAnthropicToOpenAi(config: ModelConfig): boolean {
  return config.provider !== 'claude' && (config.chatApiMode ?? 'auto') === 'auto';
}

export function isHttpBadRequest(e: unknown): boolean {
  const ax = e as { response?: { status?: number } };
  return ax?.response?.status === 400;
}

/**
 * OpenAI 兼容请求的统一降级：先带思考参数；图片不被支持则改纯文本；400 则去掉思考参数。
 * 流式/非流式共用同一业务边界，避免两处重试矩阵漂移。
 */
export async function withOpenAiCompatibleFallbacks<T>(opts: {
  messages: Message[];
  messagesHaveImages: boolean;
  errorIndicatesImageUnsupported: (e: unknown) => boolean;
  request: (mode: 'multimodal' | 'text', withThinking: boolean) => Promise<T>;
  onImageFallback?: (err: unknown) => void;
  onThinkingFallback?: (err: unknown) => void;
}): Promise<T> {
  const {
    messagesHaveImages,
    errorIndicatesImageUnsupported,
    request,
    onImageFallback,
    onThinkingFallback,
  } = opts;

  try {
    return await request('multimodal', true);
  } catch (firstErr: unknown) {
    if (messagesHaveImages && errorIndicatesImageUnsupported(firstErr)) {
      onImageFallback?.(firstErr);
      try {
        return await request('text', true);
      } catch (secondErr: unknown) {
        if (isHttpBadRequest(secondErr)) {
          onThinkingFallback?.(secondErr);
          return await request('text', false);
        }
        throw secondErr;
      }
    }
    if (isHttpBadRequest(firstErr)) {
      try {
        onThinkingFallback?.(firstErr);
        return await request('multimodal', false);
      } catch {
        throw firstErr;
      }
    }
    throw firstErr;
  }
}
