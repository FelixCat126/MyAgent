/**
 * 生图厂商预设 + Endpoint 自适配。
 *
 * 目标对齐语言模型：优先填「接口地址 + API Key（+ 模型名）」即可工作；
 * 预设仅作快捷回填。主进程按 endpoint/路径推断适配器，除非用户显式指定非 custom 厂商。
 */

export type ImageProviderId =
  | 'bailian-wanx'
  | 'volc-seedream'
  | 'openai-images'
  | 'zhipu-cogview'
  | 'minimax'
  | 'sdwebui'
  | 'ollama'
  | 'custom';

/** 可被 Endpoint 推断出的厂商（不含 custom） */
export type InferredImageProviderId = Exclude<ImageProviderId, 'custom'>;

export type ImageHttpFormat = 'auto' | 'sdwebui' | 'ollama' | 'openai_images' | 'raw';

export interface ImageProviderPreset {
  id: ImageProviderId;
  /** i18n key，用于下拉显示名 */
  labelKey: string;
  /** i18n key，一行说明 */
  descKey: string;
  type: 'http' | 'cli';
  /** 是否需要 API Key（云端为 true，本地 SD WebUI/Ollama 为 false） */
  needsApiKey: boolean;
  /** i18n key，密钥输入框占位符（可选） */
  apiKeyPlaceholderKey?: string;
  /** 默认 endpoint；选中预设时回填，用户可改 */
  defaultEndpoint?: string;
  /** 默认模型名；选中预设时回填，用户可改 */
  defaultModel?: string;
  /** 对应的 httpFormat（主进程解析响应用） */
  defaultHttpFormat?: ImageHttpFormat;
}

/**
 * 内置预设（顺序即下拉顺序）。custom 放最后。
 */
export const IMAGE_PROVIDER_PRESETS: ImageProviderPreset[] = [
  {
    id: 'bailian-wanx',
    labelKey: 'settings.form.preset.bailian',
    descKey: 'settings.form.preset.bailian.desc',
    type: 'http',
    needsApiKey: true,
    apiKeyPlaceholderKey: 'settings.form.imageApiKeyPh.bailian',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    defaultModel: 'wan2.6-t2i',
    defaultHttpFormat: 'auto',
  },
  {
    id: 'volc-seedream',
    labelKey: 'settings.form.preset.volc',
    descKey: 'settings.form.preset.volc.desc',
    type: 'http',
    needsApiKey: true,
    apiKeyPlaceholderKey: 'settings.form.imageApiKeyPh.volc',
    defaultEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    defaultModel: 'doubao-seedream-4-5-251128',
    defaultHttpFormat: 'openai_images',
  },
  {
    id: 'openai-images',
    labelKey: 'settings.form.preset.openai',
    descKey: 'settings.form.preset.openai.desc',
    type: 'http',
    needsApiKey: true,
    apiKeyPlaceholderKey: 'settings.form.imageApiKeyPh.openai',
    defaultEndpoint: 'https://api.openai.com/v1/images/generations',
    defaultModel: 'gpt-image-1',
    defaultHttpFormat: 'openai_images',
  },
  {
    id: 'zhipu-cogview',
    labelKey: 'settings.form.preset.zhipu',
    descKey: 'settings.form.preset.zhipu.desc',
    type: 'http',
    needsApiKey: true,
    apiKeyPlaceholderKey: 'settings.form.imageApiKeyPh.zhipu',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    defaultModel: 'cogview-4',
    defaultHttpFormat: 'openai_images',
  },
  {
    id: 'minimax',
    labelKey: 'settings.form.preset.minimax',
    descKey: 'settings.form.preset.minimax.desc',
    type: 'http',
    needsApiKey: true,
    apiKeyPlaceholderKey: 'settings.form.imageApiKeyPh.minimax',
    defaultEndpoint: 'https://api.minimaxi.com/v1/image_generation',
    defaultModel: 'image-01',
    defaultHttpFormat: 'auto',
  },
  {
    id: 'sdwebui',
    labelKey: 'settings.form.preset.sdwebui',
    descKey: 'settings.form.preset.sdwebui.desc',
    type: 'http',
    needsApiKey: false,
    defaultEndpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img',
    defaultHttpFormat: 'sdwebui',
  },
  {
    id: 'ollama',
    labelKey: 'settings.form.preset.ollama',
    descKey: 'settings.form.preset.ollama.desc',
    type: 'http',
    needsApiKey: false,
    defaultEndpoint: 'http://127.0.0.1:11434/api/generate',
    defaultModel: 'flux',
    defaultHttpFormat: 'ollama',
  },
  {
    id: 'custom',
    labelKey: 'settings.form.preset.custom',
    descKey: 'settings.form.preset.custom.desc',
    type: 'http',
    needsApiKey: true,
    defaultHttpFormat: 'auto',
  },
];

const PRESET_BY_ID = new Map<ImageProviderId, ImageProviderPreset>(
  IMAGE_PROVIDER_PRESETS.map((p) => [p.id, p])
);

export function getImageProviderPreset(id: string | undefined): ImageProviderPreset | undefined {
  if (!id) return undefined;
  return PRESET_BY_ID.get(id as ImageProviderId);
}

/**
 * 按 provider 精确查找预设的默认值；用于 UI 选中预设时回填表单。
 * 返回新对象，避免调用方污染预设常量。
 */
export function getPresetDefaults(id: string | undefined): Partial<{
  endpoint: string;
  model: string;
  httpFormat: ImageHttpFormat;
  type: 'http' | 'cli';
}> {
  const p = getImageProviderPreset(id);
  if (!p) return {};
  return {
    type: p.type,
    ...(p.defaultEndpoint ? { endpoint: p.defaultEndpoint } : {}),
    ...(p.defaultModel ? { model: p.defaultModel } : {}),
    ...(p.defaultHttpFormat ? { httpFormat: p.defaultHttpFormat } : {}),
  };
}

/** 显式 provider 是否视为「未指定」（交由 Endpoint 推断） */
export function isUnsetImageProvider(provider: string | undefined | null): boolean {
  return !provider || provider === 'custom';
}

/**
 * 根据 Endpoint（及可选 httpFormat）推断生图厂商。
 * 与 electron/ipc/image-gen.ts 适配器匹配规则保持一致；新增厂商时优先改此处。
 */
export function inferImageProviderFromEndpoint(
  endpoint: string,
  httpFormat?: string
): InferredImageProviderId | undefined {
  const u = String(endpoint ?? '').trim();
  if (!u) {
    if (httpFormat === 'openai_images') return 'openai-images';
    if (httpFormat === 'sdwebui') return 'sdwebui';
    if (httpFormat === 'ollama') return 'ollama';
    return undefined;
  }
  const lower = u.toLowerCase();

  if (/\bdashscope\.aliyuncs\.com\b/i.test(u) || /multimodal-generation\/generation/i.test(u)) {
    return 'bailian-wanx';
  }
  if (
    /\bapi\.minimaxi?\.(io|com|chat)\b/i.test(u) ||
    (/minimax/i.test(u) && /image_generation/i.test(u))
  ) {
    return 'minimax';
  }
  if (/volces\.com/i.test(u) && /images\/generations/i.test(u)) {
    return 'volc-seedream';
  }
  if (/bigmodel\.cn/i.test(u) && (/images\/generations/i.test(u) || /cogview/i.test(u))) {
    return 'zhipu-cogview';
  }
  if (/\/images\/generations/i.test(u)) {
    return 'openai-images';
  }
  if (lower.includes('sdapi/v1/txt2img') || /\/txt2img(?:\?|$)/i.test(u)) {
    return 'sdwebui';
  }
  if (lower.includes('/api/generate')) {
    return 'ollama';
  }

  if (httpFormat === 'openai_images') return 'openai-images';
  if (httpFormat === 'sdwebui') return 'sdwebui';
  if (httpFormat === 'ollama') return 'ollama';
  return undefined;
}

/**
 * 合并「显式厂商」与 Endpoint 推断。
 * custom / 空 → 仅用推断；显式非 custom → 以显式为准。
 */
export function resolveImageProviderId(
  explicitProvider: string | undefined | null,
  endpoint: string,
  httpFormat?: string
): InferredImageProviderId | undefined {
  if (!isUnsetImageProvider(explicitProvider)) {
    return explicitProvider as InferredImageProviderId;
  }
  return inferImageProviderFromEndpoint(endpoint, httpFormat);
}

/** 推断结果对应的建议 httpFormat（UI 回填用） */
export function suggestedHttpFormatForProvider(
  id: InferredImageProviderId | undefined
): ImageHttpFormat | undefined {
  if (!id) return undefined;
  return getImageProviderPreset(id)?.defaultHttpFormat;
}

/** 当前配置是否需要展示/填写 API Key */
export function imageGenNeedsApiKey(
  explicitProvider: string | undefined | null,
  endpoint: string,
  httpFormat?: string
): boolean {
  const id = resolveImageProviderId(explicitProvider, endpoint, httpFormat);
  if (!id) return true;
  return getImageProviderPreset(id)?.needsApiKey ?? true;
}
