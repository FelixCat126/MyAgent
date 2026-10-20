import type { ModelConfig } from '../../types';
import { getPresetDefaults, type ImageHttpFormat, type ImageProviderId } from '../../../electron/shared/imageProviderPresets';

export type VendorKind = 'cloud' | 'local';
export type ModelCategory = 'chat' | 'image' | 'embedding' | 'video' | 'audio' | 'other';

export interface VendorPreset {
  id: string;
  name: string;
  nameEn?: string;
  kind: VendorKind;
  provider: ModelConfig['provider'];
  apiUrl: string;
  chatApiMode?: NonNullable<ModelConfig['chatApiMode']>;
  /** Local channels may run without a key. */
  needsKey: boolean;
  keyUrl?: string;
  chatPrefer: RegExp[];
  image?: { preset: ImageProviderId; prefer?: RegExp[] };
  embedding?: { model?: string; prefer?: RegExp[] };
  video?: { endpoint: string; model: string };
}

export const VENDOR_PRESETS: VendorPreset[] = [
  { id: 'openai', name: 'OpenAI', kind: 'cloud', provider: 'openai', apiUrl: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys',
    chatPrefer: [/^gpt-4\.1$/, /^gpt-4o$/, /^gpt-4o-mini$/, /^gpt-/], image: { preset: 'openai-images', prefer: [/^gpt-image/, /^dall-e-3$/] }, embedding: { model: 'text-embedding-3-small', prefer: [/^text-embedding-3-small$/] } },
  { id: 'anthropic', name: 'Anthropic Claude', kind: 'cloud', provider: 'claude', apiUrl: 'https://api.anthropic.com', chatApiMode: 'anthropic', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys',
    chatPrefer: [/sonnet/i, /opus/i, /claude/i] },
  { id: 'gemini', name: 'Google Gemini', kind: 'cloud', provider: 'gemini', apiUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey',
    chatPrefer: [/gemini-[\d.]+-flash$/, /gemini-[\d.]+-pro$/, /gemini/] },
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', provider: 'custom', apiUrl: 'https://api.deepseek.com/v1', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys',
    chatPrefer: [/^deepseek-chat$/, /^deepseek/] },
  { id: 'bailian', name: '阿里云百炼', nameEn: 'Alibaba Model Studio', kind: 'cloud', provider: 'custom', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true, keyUrl: 'https://bailian.console.aliyun.com/',
    chatPrefer: [/^qwen-plus$/, /^qwen-max$/, /^qwen-turbo$/, /^qwen/], image: { preset: 'bailian-wanx', prefer: [/^wan[\d.]+-t2i/] }, embedding: { model: 'text-embedding-v3', prefer: [/^text-embedding-v\d+$/] } },
  { id: 'volc', name: '火山方舟（豆包）', nameEn: 'Volcengine Ark', kind: 'cloud', provider: 'custom', apiUrl: 'https://ark.cn-beijing.volces.com/api/v3', needsKey: true, keyUrl: 'https://console.volcengine.com/ark',
    chatPrefer: [/^doubao-seed-[\d-]+$/, /^doubao-1-5-pro/, /^doubao/], image: { preset: 'volc-seedream', prefer: [/seedream/] }, embedding: { prefer: [/doubao-embedding-text/, /doubao-embedding/] } },
  { id: 'zhipu', name: '智谱 GLM', nameEn: 'Zhipu GLM', kind: 'cloud', provider: 'custom', apiUrl: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    chatPrefer: [/^glm-4\.\d+$/, /^glm-4-plus$/, /^glm-4/, /^glm/], image: { preset: 'zhipu-cogview', prefer: [/^cogview-4/, /^cogview/] }, embedding: { model: 'embedding-3', prefer: [/^embedding-3$/] } },
  { id: 'kimi', name: 'Kimi（月之暗面）', nameEn: 'Moonshot Kimi', kind: 'cloud', provider: 'custom', apiUrl: 'https://api.moonshot.cn/v1', needsKey: true, keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    chatPrefer: [/^kimi-k2/, /^kimi-latest$/, /^moonshot-v1-auto$/, /^moonshot/] },
  { id: 'minimax', name: 'MiniMax', kind: 'cloud', provider: 'custom', apiUrl: 'https://api.minimaxi.com/v1', needsKey: true, keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    chatPrefer: [/^MiniMax-M/i, /minimax/i], image: { preset: 'minimax', prefer: [/^image-/] }, video: { endpoint: 'https://api.minimaxi.com', model: 'MiniMax-Hailuo-02' } },
  { id: 'siliconflow', name: '硅基流动', nameEn: 'SiliconFlow', kind: 'cloud', provider: 'custom', apiUrl: 'https://api.siliconflow.cn/v1', needsKey: true, keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    chatPrefer: [/^deepseek-ai\/DeepSeek-V3/, /^Qwen\/Qwen3/, /^Qwen\//], embedding: { model: 'BAAI/bge-m3', prefer: [/^BAAI\/bge-m3$/] } },
  { id: 'openrouter', name: 'OpenRouter', kind: 'cloud', provider: 'custom', apiUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/keys',
    chatPrefer: [/^openai\/gpt-4o-mini$/, /^anthropic\/claude/, /^google\/gemini/] },
  { id: 'ollama', name: 'Ollama', kind: 'local', provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', needsKey: false,
    chatPrefer: [], embedding: { prefer: [/embed/i, /bge/i] } },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', provider: 'custom', apiUrl: 'http://127.0.0.1:1234/v1', chatApiMode: 'openai', needsKey: false,
    chatPrefer: [], embedding: { prefer: [/embed/i, /bge/i] } },
  { id: 'openai-compatible-local', name: 'vLLM / 其他兼容服务', nameEn: 'vLLM / other compatible', kind: 'local', provider: 'custom', apiUrl: 'http://127.0.0.1:8000/v1', chatApiMode: 'openai', needsKey: false,
    chatPrefer: [] },
];

export function getVendorPreset(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find(v => v.id === id);
}

export function classifyModelId(id: string): ModelCategory {
  const s = id.toLowerCase();
  if (/rerank|moderation|ocr|guard/.test(s)) return 'other';
  if (/embed|(^|\/)bge-|(^|[/-])e5-|(^|\/)gte-/.test(s)) return 'embedding';
  if (/whisper|tts|(^|[-_/])audio|asr|speech|transcri|realtime/.test(s)) return 'audio';
  if (/video|hailuo|seedance|t2v|i2v|(^|\/)veo|sora|kling/.test(s)) return 'video';
  if (/(^|[-_/])image|dall-e|seedream|cogview|wanx|wan[\d.]+-t2i|flux|kolors|stable-diffusion|sdxl|imagen/.test(s)) return 'image';
  return 'chat';
}

function pickPreferred(ids: string[], prefer: RegExp[] = []): string | undefined {
  for (const pattern of prefer) {
    const hit = ids.find(id => pattern.test(id));
    if (hit) return hit;
  }
  return undefined;
}

export interface SetupPlan {
  chatCandidates: string[];
  chatModel: string;
  image?: { provider: ImageProviderId; endpoint: string; model: string; httpFormat: ImageHttpFormat };
  embeddingModel?: string;
  video?: { endpoint: string; model: string };
}

/** Build defaults from a discovered list; discovery may be empty when the service has no model listing. */
export function buildSetupPlan(vendor: VendorPreset, discovered: string[]): SetupPlan {
  const ids = [...new Set(discovered.map(id => id.trim()).filter(Boolean))];
  const byCategory = (category: ModelCategory) => ids.filter(id => classifyModelId(id) === category);
  const chatCandidates = byCategory('chat');
  const chatModel = pickPreferred(chatCandidates, vendor.chatPrefer) ?? chatCandidates[0] ?? '';
  let image: SetupPlan['image'];
  if (vendor.image) {
    const defaults = getPresetDefaults(vendor.image.preset);
    const model = pickPreferred(byCategory('image'), vendor.image.prefer) ?? defaults.model ?? '';
    if (defaults.endpoint) image = { provider: vendor.image.preset, endpoint: defaults.endpoint, model, httpFormat: defaults.httpFormat ?? 'auto' };
  }
  const embeddingModel = vendor.embedding ? pickPreferred(byCategory('embedding'), vendor.embedding.prefer) ?? vendor.embedding.model : undefined;
  return { chatCandidates, chatModel, image, embeddingModel, video: vendor.video };
}
