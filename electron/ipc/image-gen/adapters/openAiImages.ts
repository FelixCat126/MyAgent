import { normalizeReferenceImagesForApi } from '../arkBody';
import { effectiveImageProvider } from '../auth';
import { VENDOR_IMAGE_COUNT_LIMITS } from '../../../constants';
import type { HttpImageProviderAdapter } from './types';
import { resolveOpenAiCompatibleImageModel } from './shared';

const openAiImagesAdapter: HttpImageProviderAdapter = {
  id: 'openai-images',
  match: ({ endpoint, config }) => {
    const id = effectiveImageProvider(config, endpoint);
    return id === 'openai-images' || id === 'zhipu-cogview';
  },
  async build({ endpoint, config, env, request }) {
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
      ...(!/^gpt-image-|^chatgpt-image-/i.test(model) ? { response_format: rf === 'url' ? 'url' : 'b64_json' } : { output_format: 'png' }),
    };
    if (/^gpt-image-|^chatgpt-image-/i.test(model)) {
      if (request.params.background) body.background = request.params.background;
      if (config.quality) body.quality = config.quality;
      if (/^gpt-image-1(?:[.-]|$)/i.test(model) && !['1024x1024', '1536x1024', '1024x1536'].includes(size)) {
        body.size = (request.width || 1024) > (request.height || 1024) ? '1536x1024' : (request.height || 1024) > (request.width || 1024) ? '1024x1536' : '1024x1024';
      }
    }
    if (request.referenceImages.length) {
      if (isZhipu || !/^gpt-image-|^chatgpt-image-/i.test(model)) throw new Error('当前生图模型未接入图片编辑，请选择支持参考图的模型。');
      body.images = (await normalizeReferenceImagesForApi(request.params, 16)).map(image_url => ({ image_url }));
      if (!/\/images\/(generations|edits)\/?$/i.test(endpoint)) throw new Error('编辑图片需要 /images/edits 接口地址。');
      endpoint = endpoint.replace(/\/images\/generations\/?$/i, '/images/edits');
    }
    if (request.count > 1) body.n = Math.max(1, Math.min(model === 'dall-e-3' ? 1 : VENDOR_IMAGE_COUNT_LIMITS.openAiImages, request.count));
    return { provider: isZhipu ? 'zhipu-cogview' : 'openai-images', mode: 'openai_images', endpoint, body };
  },
};

export { openAiImagesAdapter };
