/**
 * 生图厂商预设表。
 *
 * 设计目标：让用户「选厂商 → 填 API Key → 完成」，无需了解各厂商的 endpoint 路径、
 * 请求格式或模型命名。每条预设固化厂商默认值；UI 选中预设后自动回填，
 * 用户仅需补一个密钥（云端）或确认本地地址（本地）。
 *
 * 预设与适配器（electron/ipc/image-gen.ts）一一对应：适配器按 `provider`
 * 精确匹配，未填 provider 时回退到 endpoint/httpFormat 推断（向后兼容老配置）。
 */

export type ImageProviderId =
  | 'bailian-wanx'
  | 'volc-seedream'
  | 'openai-images'
  | 'zhipu-cogview'
  | 'sdwebui'
  | 'ollama'
  | 'custom';

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
  defaultHttpFormat?: 'auto' | 'sdwebui' | 'ollama' | 'openai_images' | 'raw';
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
    needsApiKey: false,
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
  httpFormat: NonNullable<ImageProviderPreset['defaultHttpFormat']>;
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
