import { isUnsetImageProvider } from '../../../../src/utils/imageProviderPresets';
import { effectiveImageProvider } from '../auth';
import type { HttpImageProviderAdapter } from './types';

const ollamaAdapter: HttpImageProviderAdapter = {
  id: 'ollama',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'ollama' ||
    (isUnsetImageProvider(config.provider) && mode === 'ollama'),
  build({ endpoint, config, env, request }) {
    /** config.model 优先（新），其次 env（向后兼容） */
    const model =
      (typeof config.model === 'string' ? config.model.trim() : '') ||
      env?.OLLAMA_MODEL ||
      env?.ollama_model ||
      'flux';
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      stream: false,
    };
    if (typeof request.width === 'number' && request.width > 0) body.width = request.width;
    if (typeof request.height === 'number' && request.height > 0) body.height = request.height;
    return { provider: 'ollama', mode: 'ollama', endpoint, body, ollamaModel: model };
  },
};

export { ollamaAdapter };
