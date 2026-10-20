import { describe, expect, it } from 'vitest';
import { buildSetupPlan, classifyModelId, getVendorPreset } from './vendorCatalog';

describe('classifyModelId rerankers', () => {
  it('does not treat reranker models as embeddings', () => {
    expect(classifyModelId('BAAI/bge-reranker-v2-m3')).toBe('other');
    expect(classifyModelId('qwen3-reranker-8b')).toBe('other');
    expect(classifyModelId('BAAI/bge-m3')).toBe('embedding');
  });

  it('picks a real embedding model when a reranker is listed first', () => {
    const plan = buildSetupPlan(getVendorPreset('ollama')!, ['bge-reranker-base', 'qwen3:8b', 'bge-m3']);
    expect(plan.embeddingModel).toBe('bge-m3');
  });
});
