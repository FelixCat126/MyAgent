// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { sdWebUiAdapter } from './sdWebUi';
import { imageInputBytes, validatedMask } from '../editInputs';
import type { ImageGenerationParams } from '../../../../src/types';
function png(mask = false) { const canvas = createCanvas(8, 8); const context = canvas.getContext('2d'); context.fillStyle = 'black'; context.fillRect(0, 0, 8, 8); if (mask) context.clearRect(0, 0, 4, 8); return canvas.toBuffer('image/png'); }
const inline = (buffer: Buffer) => 'data:image/png;base64,' + buffer.toString('base64');
const build = (params: ImageGenerationParams) => sdWebUiAdapter.build({ endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', config: { type: 'http', provider: 'sdwebui' }, env: {}, headers: {}, request: { prompt: params.prompt, count: 1, width: 512, height: 512, referenceImages: params.referenceImages ?? [], params } });
describe('SD reference and mask edits', () => {
 it('routes a real image into img2img and converts transparent mask pixels into SD white pixels', async () => {
  const request = await build({ prompt: 'change left half', referenceImages: [inline(png())], maskImage: inline(png(true)), editStrength: .7 });
  expect(request.endpoint).toMatch(/img2img$/); expect(request.body).toMatchObject({ denoising_strength: .7, inpainting_mask_invert: 0, inpaint_full_res: true });
  const decoded = await loadImage(Buffer.from(request.body.mask as string, 'base64')); const canvas = createCanvas(8, 8); const context = canvas.getContext('2d'); context.drawImage(decoded, 0, 0);
  expect([...context.getImageData(1, 1, 1, 1).data]).toEqual([255,255,255,255]); expect([...context.getImageData(6, 1, 1, 1).data]).toEqual([0,0,0,255]);
 });
 it('fails for mismatched masks, masks without any edit region and unsupported reference counts', async () => {
  await expect(validatedMask(inline(createCanvas(9, 8).toBuffer('image/png')), png())).rejects.toThrow('尺寸');
  await expect(validatedMask(inline(png()), png())).rejects.toThrow('没有透明');
  await expect(build({ prompt: 'edit', referenceImages: [inline(png()), inline(png())] })).rejects.toThrow('一张');
 });
 it('rejects an oversized PNG header before decoding and does not fetch remote reference images', async () => {
  const header = Buffer.from(png()); header.writeUInt32BE(50_000, 16); header.writeUInt32BE(50_000, 20);
  await expect(imageInputBytes(inline(header))).rejects.toThrow('1600'); await expect(imageInputBytes('https://example.com/private-image.png')).rejects.toThrow('本地');
 });
});
