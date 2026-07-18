import { describe, expect, it } from 'vitest';
import {
  imageGenNeedsApiKey,
  inferImageProviderFromEndpoint,
  isUnsetImageProvider,
  resolveImageProviderId,
} from '../../electron/shared/imageProviderPresets';

describe('inferImageProviderFromEndpoint', () => {
  it('识别百炼 / MiniMax / 火山 / 智谱 / OpenAI / SD / Ollama', () => {
    expect(
      inferImageProviderFromEndpoint(
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
      )
    ).toBe('bailian-wanx');
    expect(inferImageProviderFromEndpoint('https://api.minimaxi.com/v1/image_generation')).toBe(
      'minimax'
    );
    expect(
      inferImageProviderFromEndpoint('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    ).toBe('volc-seedream');
    expect(
      inferImageProviderFromEndpoint('https://open.bigmodel.cn/api/paas/v4/images/generations')
    ).toBe('zhipu-cogview');
    expect(inferImageProviderFromEndpoint('https://api.openai.com/v1/images/generations')).toBe(
      'openai-images'
    );
    expect(inferImageProviderFromEndpoint('http://127.0.0.1:7860/sdapi/v1/txt2img')).toBe('sdwebui');
    expect(inferImageProviderFromEndpoint('http://127.0.0.1:11434/api/generate')).toBe('ollama');
  });

  it('custom / 空视为未指定，按 Endpoint 推断', () => {
    expect(isUnsetImageProvider('custom')).toBe(true);
    expect(isUnsetImageProvider('')).toBe(true);
    expect(isUnsetImageProvider('minimax')).toBe(false);
    expect(
      resolveImageProviderId('custom', 'https://api.minimax.io/v1/image_generation')
    ).toBe('minimax');
    expect(resolveImageProviderId('openai-images', 'https://api.minimaxi.com/v1/image_generation')).toBe(
      'openai-images'
    );
  });

  it('本地不需 Key，云端需要', () => {
    expect(imageGenNeedsApiKey('', 'http://127.0.0.1:7860/sdapi/v1/txt2img')).toBe(false);
    expect(imageGenNeedsApiKey('', 'https://api.openai.com/v1/images/generations')).toBe(true);
    expect(imageGenNeedsApiKey('', 'https://unknown.example/v1/foo')).toBe(true);
  });
});
