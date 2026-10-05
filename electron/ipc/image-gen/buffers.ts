import { bindImageTask, checkImageTask } from './task';
import { join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { ImageGenerationParams } from '../../../src/types';

/** Retains the legacy export name; generated files must always contain a decodable image. */
async function readImageSizeWithFallback(
  outputPath: string,
  params: ImageGenerationParams
): Promise<{ width: number; height: number }> {
  void params; checkImageTask();
  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || !stat.size || stat.size > 25 * 1024 * 1024) throw new Error('生图输出为空、不是文件或超过 25MB / Invalid or oversized image output');
  const bytes = await fs.readFile(outputPath);
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('生图输出为空或超过 25MB / Empty or oversized image output');
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000) throw new Error('生图输出超过 1600 万像素 / Image output exceeds 16 megapixels');
  const { loadImage } = await import('@napi-rs/canvas');
  let image; try { image = await loadImage(bytes); } catch { throw new Error('生图程序输出不是可解码的图片 / Image generator output is not a decodable image'); }
  if (!image.width || !image.height || image.width * image.height > 16_000_000) throw new Error('生图输出超过 1600 万像素 / Image output exceeds 16 megapixels');
  checkImageTask(); return { width: image.width, height: image.height };
}

/** 生图输出目录：params.outputDir 优先，否则 Documents/MyAgent/GeneratedImages；尽力创建 */
async function resolveImageOutputDir(params: ImageGenerationParams): Promise<string> {
  const { app } = await import('electron');
  const outputDir =
    params.outputDir || join(app.getPath('documents'), 'MyAgent', 'GeneratedImages');
  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});
  return outputDir;
}

async function writePngBuffersToOutputFiles(
  buffersWithBinaries: Buffer[],
  outputDir: string,
  params: ImageGenerationParams
): Promise<Array<{ url: string; path: string; width: number; height: number }>> {
  const results: Array<{ url: string; path: string; width: number; height: number; size?: number }> = [];
  try { for (const imageBuf of buffersWithBinaries) {
    checkImageTask();
    if (!imageBuf.length || imageBuf.length > 25 * 1024 * 1024) throw new Error('图片为空或超过 25MB / Empty or oversized image output');
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(imageBuf); if (!image.width || !image.height || image.width * image.height > 16_000_000) throw new Error('生成图片超过 1600 万像素 / Generated image exceeds 16 megapixels');
    const canvas = createCanvas(image.width, image.height); canvas.getContext('2d').drawImage(image, 0, 0); const png = canvas.toBuffer('image/png');
    checkImageTask();
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    await fs.writeFile(outputPath, png, { encoding: null, mode: 0o600 });
    results.push({ url: `file://${outputPath}`, path: outputPath, width: image.width, height: image.height, size: png.length });
  } checkImageTask(); }
  catch (error) { await Promise.all(results.map((image) => fs.unlink(image.path).catch(() => {}))); throw error; }
  void params;
  return results;
}

async function finalizeOnePngBuffer(
  imageBuf: Buffer,
  outputDir: string,
  params: ImageGenerationParams
): Promise<{ url: string; path: string; width: number; height: number }> {
  const [one] = await writePngBuffersToOutputFiles([imageBuf], outputDir, params);
  return one;
}

async function fetchImageBinaryFromUrl(imageUrl: string, timeoutMs: number): Promise<Buffer> {
  checkImageTask();
  const ctrl = new AbortController();
  const unbind = bindImageTask(ctrl);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(
        `拉取图片链接 HTTP ${res.status}；若为火山返回的过期 URL，请缩短生图链路或开大 MYAGENT_IMAGE_GEN_TIMEOUT_MS`
      );
    }
    if (Number(res.headers.get('content-length')) > 25 * 1024 * 1024) throw new Error('图片下载超过 25MB / Image download exceeds 25MB');
    const reader = res.body?.getReader(); if (!reader) throw new Error('图片下载为空 / Empty image download');
    const parts: Uint8Array[] = []; let size = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 25 * 1024 * 1024) { await reader.cancel(); throw new Error('图片下载超过 25MB / Image download exceeds 25MB'); } parts.push(chunk.value); } }
    finally { reader.releaseLock(); }
    checkImageTask(); return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
    unbind();
  }
}

export {
  writePngBuffersToOutputFiles,
  finalizeOnePngBuffer,
  fetchImageBinaryFromUrl,
  readImageSizeWithFallback,
  resolveImageOutputDir,
};
