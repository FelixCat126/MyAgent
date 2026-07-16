/**
 * HTTP 图像生成 provider 适配器共享类型定义。
 *
 * 集中维护 HttpImageProviderAdapter 契约，避免在 7 个 adapter 与编排代码间
 * 出现循环 type-import；各 adapter 文件 import 此处的类型即可。
 */

import type { ModelConfig, ImageGenerationParams } from '../../../../src/types';

export type HttpImageMode = 'sdwebui' | 'ollama' | 'raw' | 'openai_images' | 'auto';

export type UnifiedImageRequest = {
  prompt: string;
  width?: number;
  height?: number;
  count: number;
  referenceImages: string[];
  params: ImageGenerationParams;
};

export type BuiltImageHttpRequest = {
  provider: string;
  mode: HttpImageMode;
  endpoint: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  readBodyAsStreamingText?: boolean;
  volcOpenAi?: boolean;
  ollamaModel?: string;
};

export type HttpImageProviderAdapter = {
  id: string;
  match: (ctx: {
    mode: HttpImageMode;
    endpoint: string;
    config: NonNullable<ModelConfig['imageGeneratorConfig']>;
  }) => boolean;
  build: (ctx: {
    endpoint: string;
    config: NonNullable<ModelConfig['imageGeneratorConfig']>;
    env: Record<string, string> | undefined;
    request: UnifiedImageRequest;
    headers: Record<string, string>;
  }) => Promise<BuiltImageHttpRequest> | BuiltImageHttpRequest;
};

export type GeneratedImage = { url: string; path: string; width: number; height: number };
export type ImageGeneratedCallback = (image: GeneratedImage, index: number, total: number) => void;
export type CliGeneratedImage = { url: string; path: string; width: number; height: number };
