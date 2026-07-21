import { ImageGenerationParams } from '../../../../src/types';
import { hasExplicitAuthorizationHeader, effectiveImageProvider } from '../auth';
import { VENDOR_IMAGE_COUNT_LIMITS } from '../../../constants';
import { resolveAdapterImageModel } from './shared';
import type { HttpImageProviderAdapter } from './types';

/**
 * 百炼/万相响应解析（wan2.6 同步协议）：
 * { output: { choices: [ { message: { content: [ { image: "url", type: "image" } ] } } ] } }
 * 兼容旧版异步轮询结构 { output: { results: [ { url } ] } } 作为兜底。
 */
function extractImagesFromBailianResponse(data: unknown): { urls: string[]; b64s: string[] } {
  const urls: string[] = [];
  const b64s: string[] = [];
  const pushUrl = (u: unknown) => {
    const s = typeof u === 'string' ? u.trim() : '';
    if (/^https?:\/\//i.test(s)) urls.push(s);
  };
  const pushB64 = (b: unknown) => {
    const s = typeof b === 'string' ? b.trim() : '';
    if (s.length >= 48) b64s.push(s);
  };

  if (!data || typeof data !== 'object') return { urls, b64s };
  const j = data as Record<string, unknown>;
  const output = j.output as Record<string, unknown> | undefined;

  /** wan2.6 同步：output.choices[].message.content[].image */
  const choicesRaw: unknown = output?.choices;
  if (Array.isArray(choicesRaw)) {
    for (const choice of choicesRaw) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const message = c.message as Record<string, unknown> | undefined;
      const contentRaw: unknown = message?.content;
      if (Array.isArray(contentRaw)) {
        for (const item of contentRaw) {
          if (!item || typeof item !== 'object') continue;
          const ci = item as Record<string, unknown>;
          pushUrl(ci.image);
          pushB64(ci.image);
        }
      }
    }
  }

  /** 兼容旧版异步轮询：output.results[].url */
  const resultsRaw: unknown = output?.results;
  if (Array.isArray(resultsRaw)) {
    for (const item of resultsRaw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      pushUrl(r.url);
      pushB64(r.b64_image);
      pushB64(r.image);
    }
  }

  /** 兜底：递归找任何 image/url 字段 */
  if (!urls.length && !b64s.length) {
    for (const v of Object.values(j)) {
      if (typeof v === 'string') {
        pushUrl(v);
        pushB64(v);
      }
    }
  }
  return { urls, b64s };
}

/**
 * 百炼/万相 wan2.6 size 格式为 "宽*高"（星号分隔），总像素在 [1280*1280, 1440*1440] 之间。
 * 用户未指定时默认 1280*1280；可通过 env.IMAGE_SIZE 覆盖。
 */
function inferBailianWanxSize(params: ImageGenerationParams, env: Record<string, string> | undefined): string {
  const forced = (env?.IMAGE_SIZE || env?.WANX_SIZE || '').trim();
  if (forced) return forced;
  const w = typeof params.width === 'number' && params.width > 0 ? Math.round(params.width) : 1280;
  const h = typeof params.height === 'number' && params.height > 0 ? Math.round(params.height) : 1280;
  return `${w}*${h}`;
}

const bailianWanxAdapter: HttpImageProviderAdapter = {
  id: 'bailian-wanx',
  match: ({ config, endpoint }) => effectiveImageProvider(config, endpoint) === 'bailian-wanx',
  async build({ endpoint, config, env, request, headers }) {
    /** 防御：wan2.6 同步调用必须用 multimodal-generation/generation；旧版 image-synthesis 会返回异步 task_id */
    if (!/multimodal-generation\/generation/i.test(endpoint)) {
      throw new Error(
        '百炼/万相接口地址不正确：wan2.6 同步调用请使用 `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`。请在「高级」中检查或重新选择「百炼/通义万相」预设以自动填入。'
      );
    }
    if (!hasExplicitAuthorizationHeader(headers)) {
      throw new Error(
        '百炼/万相鉴权未带上：请在生图模型「API 密钥」字段填写 DashScope Key，或在「环境变量」中填写 `DASHSCOPE_API_KEY=sk-…`。'
      );
    }
    /** config.model 优先（新），其次 env（向后兼容） */
    const model = resolveAdapterImageModel({
      config,
      env,
      envKeys: ['REMOTE_IMAGE_MODEL', 'IMAGE_MODEL', 'WANX_MODEL'],
    });
    if (!model) {
      throw new Error(
        '百炼/万相请填写模型名（设置中的「模型名」或环境变量 `REMOTE_IMAGE_MODEL`/`IMAGE_MODEL`，例：wan2.6-t2i）。'
      );
    }
    const size = inferBailianWanxSize(request.params, env);
    const n =
      typeof request.count === 'number' && request.count > 0
        ? Math.max(1, Math.min(VENDOR_IMAGE_COUNT_LIMITS.bailianWanx, Math.round(request.count)))
        : 1;
    /** wan2.6 同步协议请求体：input.messages[].content[].text + parameters */
    const body: Record<string, unknown> = {
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: request.prompt ?? '' }],
          },
        ],
      },
      parameters: {
        size,
        n,
        watermark: false,
        prompt_extend: true,
      },
    };
    return { provider: 'bailian-wanx', mode: 'auto', endpoint, body };
  },
};

export { bailianWanxAdapter, extractImagesFromBailianResponse, inferBailianWanxSize };
