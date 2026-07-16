import { isUnsetImageProvider } from '../../../../src/utils/imageProviderPresets';
import { hasExplicitAuthorizationHeader, effectiveImageProvider } from '../auth';
import { isVolcArkImageGenerationsEndpoint, arkVolcDoubaoCompatibleRequestBody } from '../arkBody';
import type { HttpImageProviderAdapter } from './types';
import { resolveOpenAiCompatibleImageModel } from './shared';

const volcSeedreamAdapter: HttpImageProviderAdapter = {
  id: 'volc-seedream',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'volc-seedream' ||
    (isUnsetImageProvider(config.provider) &&
      mode === 'openai_images' &&
      isVolcArkImageGenerationsEndpoint(endpoint)),
  async build({ endpoint, config, env, request, headers }) {
    if (!hasExplicitAuthorizationHeader(headers)) {
      throw new Error(
        '火山方舟返回 401 多为鉴权未带上：请在生图模型「API 密钥」字段填写密钥，或在「环境变量」中填写 `ARK_API_KEY=你的密钥`（等价于 curl 的 Bearer），或填写 `HEADER_AUTHORIZATION=Bearer 你的密钥`；不要使用对话模型的 Key 占位。'
      );
    }
    const model = resolveOpenAiCompatibleImageModel(config, env, true);
    const body = await arkVolcDoubaoCompatibleRequestBody(env, model, request.params);
    return {
      provider: 'volc-seedream',
      mode: 'openai_images',
      endpoint,
      body,
      readBodyAsStreamingText: Boolean(body.stream),
      volcOpenAi: true,
    };
  },
};

export { volcSeedreamAdapter };
