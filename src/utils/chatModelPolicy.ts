import { hasCurrentCapability } from '../store/connectionStore';
import { ChatSession, ModelConfig } from '../types';
import { resolveChatApiMode } from './chatApiMode';

export function isZhipuModel(m: ModelConfig): boolean {
  return m.apiUrl.includes('bigmodel.cn') || m.modelName.toLowerCase().startsWith('glm-');
}

/** 与主进程 model-stream 支持范围一致，用于是否走 SSE */
export function canUseSseStream(model: ModelConfig): boolean {
  if(hasCurrentCapability(model,'stream')===false)return false;
  if (model.provider === 'gemini') return false;
  if (resolveChatApiMode(model) === 'anthropic') return true;
  if (model.provider === 'openai' || model.provider === 'custom' || model.provider === 'ollama') {
    return true;
  }
  return isZhipuModel(model);
}

export function effectiveWebEnabled(
  session: ChatSession | undefined,
  globalOn: boolean
): boolean {
  if (session?.webSearchOverride === 'off') return false;
  if (session?.webSearchOverride === 'on') return true;
  return globalOn;
}
