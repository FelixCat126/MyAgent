import type { HttpImageProviderAdapter } from './types';

const rawAutoAdapter: HttpImageProviderAdapter = {
  id: 'raw-auto',
  match: () => true,
  build({ endpoint, request }) {
    return {
      provider: 'raw-auto',
      mode: 'auto',
      endpoint,
      body: {
        prompt: request.prompt,
        width: request.width,
        height: request.height,
      },
    };
  },
};

export { rawAutoAdapter };
