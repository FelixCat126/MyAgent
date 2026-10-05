import { imageInputBytes, validatedMask } from '../editInputs';
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
    let formData: FormData | undefined;
    if (request.params.maskImage && !request.referenceImages.length) throw new Error('蒙版编辑需要参考图 / Mask editing requires an input image');
    if (request.referenceImages.length) {
      if (isZhipu || !/^gpt-image-|^chatgpt-image-/i.test(model)) throw new Error('当前生图模型未接入图片编辑，请选择支持参考图的模型。');
      if (request.referenceImages.length > 16) throw new Error('最多 16 张参考图 / At most 16 reference images');
      formData = new FormData();
      const images = await Promise.all(request.referenceImages.map(imageInputBytes));
      for (let i = 0; i < images.length; i++) formData.append(images.length > 1 ? 'image[]' : 'image', new Blob([new Uint8Array(images[i].buffer)], { type: images[i].mime }), `input-${i + 1}.${images[i].mime === 'image/jpeg' ? 'jpg' : images[i].mime === 'image/webp' ? 'webp' : 'png'}`);
      if (request.params.maskImage) formData.append('mask', new Blob([new Uint8Array(await validatedMask(request.params.maskImage, images[0].buffer))], { type: 'image/png' }), 'mask.png');
      if (!/\/images\/(generations|edits)\/?$/i.test(endpoint)) throw new Error('编辑图片需要 /images/edits 接口地址。');
      endpoint = endpoint.replace(/\/images\/generations\/?$/i, '/images/edits');
    }
    if (request.count > 1) body.n = Math.max(1, Math.min(model === 'dall-e-3' ? 1 : VENDOR_IMAGE_COUNT_LIMITS.openAiImages, request.count));
    if (formData) for (const [key, value] of Object.entries(body)) formData.append(key, String(value));
    return { provider: isZhipu ? 'zhipu-cogview' : 'openai-images', mode: 'openai_images', endpoint, body, formData };
  },
};

export { openAiImagesAdapter };
