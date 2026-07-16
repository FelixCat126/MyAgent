import { ipcMain } from 'electron';
import type { ModelConfig, ImageGenerationParams } from '../../src/types';
import { enqueueSerializedImageGeneration } from './image-gen/queue';
import {
  generateImageHttp,
  detectHttpFormat,
  buildSiblingEndpoint,
  fetchOllamaVersion,
  tryOllamaOpenAiImagesFallback,
  summarizeOllamaProgressOnlyBody,
  extractImageFromOllamaFriendlyBody,
  buildUnifiedImageRequest,
  buildImageHttpRequestViaAdapter,
  describeImageHttpAuth,
} from './image-gen/http';
import {
  generateImageCli,
  generateImageCliOneShot,
  applyCliPlaceholders,
  looksLikeWindowsExec,
  appendCappedCliLog,
} from './image-gen/cli';
import { nodeRawPostJsonBody } from './image-gen/httpClient';
import {
  isVolcArkImageGenerationsEndpoint,
  parseEnvBoolFlexible,
  parseArkImageFieldFromEnv,
  normalizeReferenceImageForApi,
  normalizeReferenceImagesForApi,
  inferVolcArkDoubaoSizeFromParams,
  inferArkStreamFlag,
  arkVolcDoubaoCompatibleRequestBody,
  imageMimeFromPath,
} from './image-gen/arkBody';
import {
  writePngBuffersToOutputFiles,
  finalizeOnePngBuffer,
  fetchImageBinaryFromUrl,
} from './image-gen/buffers';
import {
  extractImageBufferFromJson,
  extractImageDeepScan,
  extractOpenAiCompatibleImageDownloadUrl,
  extractAllOpenAiCompatibleImageUrls,
  collectImageUrlsFromArkStreamOrPlainJson,
  readResponseBodyAsUtf8Streaming,
} from './image-gen/responseParsers';
import {
  httpImageProviderAdapters,
  volcSeedreamAdapter,
  openAiImagesAdapter,
  sdWebUiAdapter,
  ollamaAdapter,
  rawAutoAdapter,
  bailianWanxAdapter,
  extractImagesFromBailianResponse,
  inferBailianWanxSize,
  minimaxAdapter,
  extractImagesFromMiniMaxResponse,
  inferMiniMaxAspectRatio,
  looksLikeMiniMaxResponseJson,
  formatMiniMaxStatusError,
  assertMiniMaxBaseRespOk,
  peekMiniMaxStatusCode,
  normalizeMiniMaxImageEndpoint,
  alternateMiniMaxImageEndpoint,
  type HttpImageMode,
  type UnifiedImageRequest,
  type BuiltImageHttpRequest,
  type HttpImageProviderAdapter,
  type GeneratedImage,
  type ImageGeneratedCallback,
  type CliGeneratedImage,
} from './image-gen/adapters';

function isUsableImageConfig(
  c: ModelConfig['imageGeneratorConfig'] | undefined
): c is NonNullable<ModelConfig['imageGeneratorConfig']> {
  if (!c) return false;
  if (c.type === 'http') return Boolean(c.endpoint && String(c.endpoint).trim());
  return Boolean(c.command && String(c.command).trim());
}

ipcMain.handle('generate-image', (event, params: ImageGenerationParams) =>
  enqueueSerializedImageGeneration(() => invokeGenerateImageIpc(params, (image, index, total) => {
    if (!params.streamRequestId) return;
    event.sender.send('image-generation-image', {
      requestId: params.streamRequestId,
      image,
      index,
      total,
    });
  }))
);

async function invokeGenerateImageIpc(params: ImageGenerationParams, onImage?: ImageGeneratedCallback) {
  const config = params.imageGeneratorConfig;
  if (!isUsableImageConfig(config)) {
    throw new Error(
      '未配置图像生成工具：请在设置中添加模型并勾选「生图工具」，填写 CLI 或 HTTP；保存后重试。'
    );
  }

  try {
    if (config.type === 'http') {
      /** HTTP 多张补齐：各厂商单次请求有上限（百炼4、火山~15、OpenAI10、SDWebUI8、Ollama/raw1），
       *  当期望张数超过单次返回时，串行循环补齐，使最终总数尽量接近用户期望。 */
      const desiredCount =
        typeof params.count === 'number' && params.count > 0 ? Math.max(1, params.count) : 1;
      const collected: GeneratedImage[] = [];
      /** 安全上限：防止异常死循环 */
      const maxRounds = Math.min(12, Math.ceil(desiredCount / 1));
      for (let round = 0; round < maxRounds && collected.length < desiredCount; round++) {
        const remaining = desiredCount - collected.length;
        const roundParams: ImageGenerationParams = {
          ...params,
          count: remaining,
        };
        const imgs = await generateImageHttp(roundParams, config);
        if (imgs.length === 0) break; // 厂商没返回，继续也没意义
        for (const img of imgs) {
          collected.push(img);
          onImage?.(img, collected.length, desiredCount);
        }
        /** 厂商单次就满足了，或本轮没进展（返回数<=0），停止避免空转 */
        if (imgs.length >= remaining) break;
      }
      return collected;
    }
    return await generateImageCli(params, config, onImage);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error('生图失败: ' + msg);
  }
}

/**
 * 重新导出子模块公开符号以保持外部行为兼容。
 * 虽然 main.ts 只做副作用导入（ipcMain.handle），其他消费方仍可能按名称引用。
 */
export {
  generateImageHttp,
  detectHttpFormat,
  buildSiblingEndpoint,
  fetchOllamaVersion,
  tryOllamaOpenAiImagesFallback,
  summarizeOllamaProgressOnlyBody,
  extractImageFromOllamaFriendlyBody,
  buildUnifiedImageRequest,
  buildImageHttpRequestViaAdapter,
  describeImageHttpAuth,
  generateImageCli,
  generateImageCliOneShot,
  applyCliPlaceholders,
  looksLikeWindowsExec,
  appendCappedCliLog,
  nodeRawPostJsonBody,
  isVolcArkImageGenerationsEndpoint,
  parseEnvBoolFlexible,
  parseArkImageFieldFromEnv,
  normalizeReferenceImageForApi,
  normalizeReferenceImagesForApi,
  inferVolcArkDoubaoSizeFromParams,
  inferArkStreamFlag,
  arkVolcDoubaoCompatibleRequestBody,
  imageMimeFromPath,
  writePngBuffersToOutputFiles,
  finalizeOnePngBuffer,
  fetchImageBinaryFromUrl,
  extractImageBufferFromJson,
  extractImageDeepScan,
  extractOpenAiCompatibleImageDownloadUrl,
  extractAllOpenAiCompatibleImageUrls,
  collectImageUrlsFromArkStreamOrPlainJson,
  readResponseBodyAsUtf8Streaming,
  httpImageProviderAdapters,
  volcSeedreamAdapter,
  openAiImagesAdapter,
  sdWebUiAdapter,
  ollamaAdapter,
  rawAutoAdapter,
  bailianWanxAdapter,
  extractImagesFromBailianResponse,
  inferBailianWanxSize,
  minimaxAdapter,
  extractImagesFromMiniMaxResponse,
  inferMiniMaxAspectRatio,
  looksLikeMiniMaxResponseJson,
  formatMiniMaxStatusError,
  assertMiniMaxBaseRespOk,
  peekMiniMaxStatusCode,
  normalizeMiniMaxImageEndpoint,
  alternateMiniMaxImageEndpoint,
};

export type {
  HttpImageMode,
  UnifiedImageRequest,
  BuiltImageHttpRequest,
  HttpImageProviderAdapter,
  GeneratedImage,
  ImageGeneratedCallback,
  CliGeneratedImage,
};
