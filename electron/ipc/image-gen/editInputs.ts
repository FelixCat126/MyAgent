import fs from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { isAgentPathAllowed } from '../../utils/agentPathScope';
import { checkImageTask } from './task';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
function checkDimensions(width: number, height: number) { if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('图片超过 1600 万像素，请先缩小 / Resize images above 16 megapixels'); }
export async function imageInputBytes(reference: string): Promise<{ buffer: Buffer; mime: string }> {
  checkImageTask();
  const data = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(reference);
  let buffer: Buffer; let mime = 'image/png';
  if (data) { if (data[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片输入超过 25MB / Image input exceeds 25MB'); buffer = Buffer.from(data[2], 'base64'); mime = data[1].toLowerCase(); }
  else {
    if (/^[a-z]+:/i.test(reference)) throw new Error('编辑图片须使用本地文件或内联图像 / Use a local or inline image for editing');
    const real = await fs.realpath(reference); if (!isAgentPathAllowed(real, [])) throw new Error('禁止读取系统目录 / System path denied');
    const stat = await fs.stat(real); if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('图片不存在或超过 25MB / Invalid or oversized image');
    buffer = await fs.readFile(real); mime = /\.jpe?g$/i.test(reference) ? 'image/jpeg' : /\.webp$/i.test(reference) ? 'image/webp' : 'image/png';
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 25MB / Empty or oversized image');
  // Reject oversized PNG headers before native decoding allocates the pixel buffer.
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { mime = 'image/png'; checkDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20)); }
  else if (buffer[0] === 255 && buffer[1] === 216) mime = 'image/jpeg';
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else throw new Error('仅支持 PNG/JPEG/WebP 图片 / PNG, JPEG or WebP required');
  const decoded = await loadImage(buffer); checkDimensions(decoded.width, decoded.height); checkImageTask(); return { buffer, mime };
}
export async function validatedMask(mask: string, firstImage: Buffer): Promise<Buffer> {
  const { buffer, mime } = await imageInputBytes(mask);
  if (mime !== 'image/png' || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('蒙版必须是 PNG / Mask must be PNG');
  const [image, decoded] = await Promise.all([loadImage(firstImage), loadImage(buffer)]);
  if (image.width !== decoded.width || image.height !== decoded.height) throw new Error('蒙版与第一张参考图尺寸必须相同 / Mask must match the first reference image');
  const canvas = createCanvas(decoded.width, decoded.height); const context = canvas.getContext('2d'); context.drawImage(decoded, 0, 0);
  const pixels = context.getImageData(0, 0, decoded.width, decoded.height).data;
  let editable = false; for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] < 255) { editable = true; break; } }
  if (!editable) throw new Error('蒙版没有透明修改区域 / Mask has no transparent edit region');
  return buffer;
}
