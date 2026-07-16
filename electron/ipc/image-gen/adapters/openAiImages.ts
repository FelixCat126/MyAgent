import { effectiveImageProvider } from '../auth';
import type { HttpImageProviderAdapter } from './types';
import { resolveOpenAiCompatibleImageModel } from './shared';

const openAiImagesAdapter: HttpImageProviderAdapter = {
  id: 'openai-images',
  match: ({ endpoint, config }) => {
    const id = effectiveImageProvider(config, endpoint);
    return id === 'openai-images' || id === 'zhipu-cogview';
  },
  build({ endpoint, config, env, request }) {
    const model = resolveOpenAiCompatibleImageModel(config, env, false);
    /** 智谱 CogView 只返回 URL（不支持 b64_json），强制用 url */
    const isZhipu =
      effectiveImageProvider(config, endpoint) === 'zhipu-cogview' ||
      /\bbigmodel\.cn\b/i.test(endpoint);
    const rf = isZhipu
      ? 'url'
      : (env?.IMAGE_RESPONSE_FORMAT || env?.RESPONSE_FORMAT || '').trim() || 'b64_json';
    let size =
      typeof request.width === 'number' &&
      request.width > 0 &&
      typeof request.height === 'number' &&
      request.height > 0
        ? `${Math.round(request.width)}x${Math.round(request.height)}`
        : '1024x1024';
    const forcedSize = (env?.ARK_SIZE || env?.IMAGE_SIZE || '').trim();
    if (forcedSize) size = forcedSize;
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      size,
      response_format: rf === 'url' ? 'url' : 'b64_json',
    };
    if (request.count > 1) body.n = Math.max(1, Math.min(10, request.count));
    return { provider: isZhipu ? 'zhipu-cogview' : 'openai-images', mode: 'openai_images', endpoint, body };
  },
};

export { openAiImagesAdapter };
