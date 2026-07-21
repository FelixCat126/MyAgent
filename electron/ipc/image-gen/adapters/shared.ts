/**
 * Adapter 间共享的小型 helper。
 *
 * 仅承载跨 adapter 复用的纯函数（不依赖具体 provider 行为），保持各 adapter 文件
 * 的纯搬迁与可读性。
 */

import type { ModelConfig } from '../../../../src/types';

/**
 * adapter 模型名解析统一：结构化 config.model 优先 → envKeys 顺序探测 → fallback。
 * envKeys 由各 adapter 显式给出（厂商间候选集不同：ollama 不含通用 key）。
 */
function resolveAdapterImageModel(opts: {
  config: NonNullable<ModelConfig['imageGeneratorConfig']>;
  env: Record<string, string> | undefined;
  envKeys: string[];
  fallback?: string;
}): string {
  const structured = typeof opts.config.model === 'string' ? opts.config.model.trim() : '';
  if (structured) return structured;
  for (const k of opts.envKeys) {
    const v = typeof opts.env?.[k] === 'string' ? String(opts.env[k]).trim() : '';
    if (v) return v;
  }
  return opts.fallback ?? '';
}

function resolveOpenAiCompatibleImageModel(
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  env: Record<string, string> | undefined,
  volcArk: boolean
): string {
  const model = resolveAdapterImageModel({
    config,
    env,
    envKeys: ['REMOTE_IMAGE_MODEL', 'IMAGE_MODEL', 'ARK_IMAGE_MODEL', 'DOUBAO_IMAGE_MODEL'],
  });
  if (!model) {
    const example = volcArk ? 'doubao-seedream-4-5-251128' : 'gpt-image-1';
    throw new Error(
      `OpenAI Images 请填写模型名（设置中的「模型名」或环境变量 \`REMOTE_IMAGE_MODEL\`/\`IMAGE_MODEL\`，例：${example}）。鉴权可用「API 密钥」字段、\`ARK_API_KEY=…\` 或 \`HEADER_AUTHORIZATION=Bearer …\`。`
    );
  }
  return model;
}

export { resolveAdapterImageModel, resolveOpenAiCompatibleImageModel };
