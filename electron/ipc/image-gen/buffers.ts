import { join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { ImageGenerationParams } from '../../../src/types';

async function writePngBuffersToOutputFiles(
  buffersWithBinaries: Buffer[],
  outputDir: string,
  params: ImageGenerationParams
): Promise<Array<{ url: string; path: string; width: number; height: number }>> {
  const results: Array<{ url: string; path: string; width: number; height: number }> = [];
  for (const imageBuf of buffersWithBinaries) {
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    await fs.writeFile(outputPath, imageBuf, { encoding: null });
    let w = Number(params.width) || 512;
    let h = Number(params.height) || 512;
    try {
      const sharp = require('sharp');
      const m = await sharp(outputPath).metadata();
      if (Number.isInteger(m.width) && m.width && m.width > 0) w = m.width;
      if (Number.isInteger(m.height) && m.height && m.height > 0) h = m.height;
    } catch {
      /* no sharp */
    }
    results.push({ url: `file://${outputPath}`, path: outputPath, width: w, height: h });
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
};
