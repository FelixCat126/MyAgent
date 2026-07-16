/**
 * Adapter 间共享的小型 helper。
 *
 * 仅承载跨 adapter 复用的纯函数（不依赖具体 provider 行为），保持各 adapter 文件
 * 的纯搬迁与可读性。
 */

import type { ModelConfig } from '../../../../src/types';

function resolveOpenAiCompatibleImageModel(
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  env: Record<string, string> | undefined,
  volcArk: boolean
): string {
  /** 结构化 config.model 优先（新）；其次 env 厂商候选 key（向后兼容） */
  const structured = typeof config.model === 'string' ? config.model.trim() : '';
  if (structured) return structured;

  const modelEnv =
    env?.REMOTE_IMAGE_MODEL ||
    env?.IMAGE_MODEL ||
    env?.ARK_IMAGE_MODEL ||
    env?.DOUBAO_IMAGE_MODEL ||
    '';
  const model =
    typeof modelEnv === 'string' ? modelEnv.trim() : String(modelEnv ?? '').trim();
  if (!model) {
    const example = volcArk ? 'doubao-seedream-4-5-251128' : 'gpt-image-1';
    throw new Error(
      `OpenAI Images 请填写模型名（设置中的「模型名」或环境变量 \`REMOTE_IMAGE_MODEL\`/\`IMAGE_MODEL\`，例：${example}）。鉴权可用「API 密钥」字段、\`ARK_API_KEY=…\` 或 \`HEADER_AUTHORIZATION=Bearer …\`。`
    );
  }
  return model;
}

export { resolveOpenAiCompatibleImageModel };
