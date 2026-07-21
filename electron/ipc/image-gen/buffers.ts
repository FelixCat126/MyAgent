import { join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { ImageGenerationParams } from '../../../src/types';

/** sharp 读图片尺寸；读取失败或无 sharp 时回退 params 宽高（最终 512） */
async function readImageSizeWithFallback(
  outputPath: string,
  params: ImageGenerationParams
): Promise<{ width: number; height: number }> {
  const fallback = { width: Number(params.width) || 512, height: Number(params.height) || 512 };
  try {
    const sharp = require('sharp');
    const m = await sharp(outputPath).metadata();
    return {
      width: Number.isInteger(m.width) && (m.width as number) > 0 ? (m.width as number) : fallback.width,
      height:
        Number.isInteger(m.height) && (m.height as number) > 0 ? (m.height as number) : fallback.height,
    };
  } catch {
    return fallback;
  }
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
  for (const imageBuf of buffersWithBinaries) {
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    await fs.writeFile(outputPath, imageBuf, { encoding: null });
    const { width: w, height: h } = await readImageSizeWithFallback(outputPath, params);
    results.push({ url: `file://${outputPath}`, path: outputPath, width: w, height: h, size: imageBuf.length });
  }
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      throw new Error(
        `拉取图片链接 HTTP ${res.status}；若为火山返回的过期 URL，请缩短生图链路或开大 MYAGENT_IMAGE_GEN_TIMEOUT_MS`
      );
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export {
  writePngBuffersToOutputFiles,
  finalizeOnePngBuffer,
  fetchImageBinaryFromUrl,
  readImageSizeWithFallback,
  resolveImageOutputDir,
};
