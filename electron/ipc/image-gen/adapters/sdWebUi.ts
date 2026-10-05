import { isUnsetImageProvider } from '../../../shared/imageProviderPresets';
import { imageInputBytes, validatedMask } from '../editInputs';
import { effectiveImageProvider } from '../auth';
import { VENDOR_IMAGE_COUNT_LIMITS } from '../../../constants';
import type { HttpImageProviderAdapter } from './types';

const sdWebUiAdapter: HttpImageProviderAdapter = {
  id: 'sdwebui',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'sdwebui' ||
    (isUnsetImageProvider(config.provider) && mode === 'sdwebui'),
  async build({ endpoint, request }) {
    if (request.referenceImages.length > 1) throw new Error('SD WebUI 编辑一次支持一张参考图 / SD WebUI edits accept one input image');
    if (request.params.maskImage && !request.referenceImages.length) throw new Error('蒙版编辑需要参考图 / Mask requires an input image');
    const edit: Record<string, unknown> = {};
    if (request.referenceImages.length) {
      const input = await imageInputBytes(request.referenceImages[0]);
      edit.init_images = [input.buffer.toString('base64')];
      edit.denoising_strength = Math.max(0, Math.min(1, request.params.editStrength ?? .45));
      endpoint = endpoint.replace(/\/txt2img\/?$/i, '/img2img');
      if (!/\/img2img\/?$/i.test(endpoint)) throw new Error('SD 编辑需要 /sdapi/v1/img2img / SD edit endpoint is required');
      if (request.params.maskImage) {
        const png = await validatedMask(request.params.maskImage, input.buffer);
        const { createCanvas, loadImage } = await import('@napi-rs/canvas');
        const mask = await loadImage(png); const canvas = createCanvas(mask.width, mask.height);
        const context = canvas.getContext('2d'); context.drawImage(mask, 0, 0);
        const pixels = context.getImageData(0, 0, mask.width, mask.height);
        // OpenAI uses alpha=0 for editable pixels; SD uses white luminance.
        for (let i = 0; i < pixels.data.length; i += 4) { const value = 255 - pixels.data[i + 3]; pixels.data[i] = value; pixels.data[i + 1] = value; pixels.data[i + 2] = value; pixels.data[i + 3] = 255; }
        context.putImageData(pixels, 0, 0); edit.mask = canvas.toBuffer('image/png').toString('base64'); edit.inpainting_mask_invert = 0; edit.inpaint_full_res = true;
      }
    }
    return {
      provider: 'sdwebui',
      mode: 'sdwebui',
      endpoint,
      body: {
        ...edit,
        prompt: request.prompt,
        negative_prompt: '',
        steps: 25,
        width: request.width || 512,
        height: request.height || 512,
        cfg_scale: 7,
        sampler_index: 'Euler a',
        n_iter: 1,
        batch_size: Math.max(1, Math.min(VENDOR_IMAGE_COUNT_LIMITS.sdWebUi, request.count)),
      },
    };
  },
};

export { sdWebUiAdapter };
