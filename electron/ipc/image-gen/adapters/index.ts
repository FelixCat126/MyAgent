/**
 * HTTP 图像生成 provider 适配器聚合。
 *
 * 顺序：bailian-wanx 与 minimax 先于 volc-seedream（避免「未指定 provider + openai_images 模式」
 * 时被 volcSeedream 误吃），其余按 OpenAI/SDWebUI/Ollama/raw-auto 排。
 */

import { volcSeedreamAdapter } from './volcSeedream';
import { openAiImagesAdapter } from './openAiImages';
import { sdWebUiAdapter } from './sdWebUi';
import { ollamaAdapter } from './ollama';
import { rawAutoAdapter } from './rawAuto';
import { bailianWanxAdapter } from './bailianWanx';
import { minimaxAdapter } from './minimax';
import type { HttpImageProviderAdapter } from './types';

export const httpImageProviderAdapters: HttpImageProviderAdapter[] = [
  bailianWanxAdapter,
  minimaxAdapter,
  volcSeedreamAdapter,
  openAiImagesAdapter,
  sdWebUiAdapter,
  ollamaAdapter,
  rawAutoAdapter,
];

export * from './types';
export { volcSeedreamAdapter } from './volcSeedream';
export { openAiImagesAdapter } from './openAiImages';
export { sdWebUiAdapter } from './sdWebUi';
export { ollamaAdapter } from './ollama';
export { rawAutoAdapter } from './rawAuto';
export {
  bailianWanxAdapter,
  extractImagesFromBailianResponse,
  inferBailianWanxSize,
} from './bailianWanx';
export {
  minimaxAdapter,
  extractImagesFromMiniMaxResponse,
  inferMiniMaxAspectRatio,
  looksLikeMiniMaxResponseJson,
  formatMiniMaxStatusError,
  assertMiniMaxBaseRespOk,
  peekMiniMaxStatusCode,
  normalizeMiniMaxImageEndpoint,
  alternateMiniMaxImageEndpoint,
  MINIMAX_SITE_MISMATCH_CODE,
} from './minimax';
