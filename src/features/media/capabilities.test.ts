import { describe, expect, it } from 'vitest';
import { imageCapabilities } from './capabilities';
describe('provider-backed image capabilities', () => {
  it('offers GPT Image supported sizes and actual edit/mask support', () => { const value = imageCapabilities({ type: 'http', provider: 'openai-images', model: 'gpt-image-1' }); expect(value.editing).toBe(true); expect(value.mask).toBe(true); expect(value.sizes.map((s) => s.label)).toEqual(['1024 × 1024', '1536 × 1024', '1024 × 1536']); });
  it('distinguishes references from masked edits and refuses unavailable providers', () => { expect(imageCapabilities({ type: 'http', provider: 'volc-seedream' }).mask).toBe(false); expect(imageCapabilities({ type: 'http', provider: 'volc-seedream' }).editing).toBe(true); expect(imageCapabilities({ type: 'cli', command: 'fixture' }).editing).toBe(false); expect(imageCapabilities({ type: 'http', provider: 'openai-images', model: 'dall-e-3' }).editing).toBe(false); });
  it('infers migrated custom SD and supports configured dimension overrides', () => { const value = imageCapabilities({ type: 'http', provider: 'custom', endpoint: 'http://127.0.0.1/sdapi/v1/txt2img', dimensions: [{ width: 640, height: 480 }] }); expect(value.mask).toBe(true); expect(value.maxReferences).toBe(1); expect(value.sizes[0].label).toBe('640 × 480'); });
});
