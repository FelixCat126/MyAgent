import { isUnsetImageProvider } from '../../../../src/utils/imageProviderPresets';
import { effectiveImageProvider } from '../auth';
import type { HttpImageProviderAdapter } from './types';

const sdWebUiAdapter: HttpImageProviderAdapter = {
  id: 'sdwebui',
  match: ({ mode, endpoint, config }) =>
    effectiveImageProvider(config, endpoint) === 'sdwebui' ||
    (isUnsetImageProvider(config.provider) && mode === 'sdwebui'),
  build({ endpoint, request }) {
    return {
      provider: 'sdwebui',
      mode: 'sdwebui',
      endpoint,
      body: {
        prompt: request.prompt,
        negative_prompt: '',
        steps: 25,
        width: request.width || 512,
        height: request.height || 512,
        cfg_scale: 7,
        sampler_index: 'Euler a',
        n_iter: 1,
        batch_size: Math.max(1, Math.min(8, request.count)),
      },
    };
  },
};

export { sdWebUiAdapter };
