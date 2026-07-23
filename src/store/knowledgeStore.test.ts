import { beforeEach, describe, expect, it } from 'vitest';
import { useKnowledgeStore } from './knowledgeStore';
import { PERSIST_KEYS } from '../utils/persistKeys';

function reset() {
  localStorage.removeItem(PERSIST_KEYS.knowledge);
  useKnowledgeStore.setState({
    vectorRagEnabled: false,
    vectorTopK: 5,
    ragMaxInjectChars: 12_000,
    embeddingProvider: 'off',
    embeddingApiUrl: '',
    embeddingApiKey: '',
    embeddingModel: '',
    embeddingVolcMultimodal: false,
  });
}

describe('knowledgeStore', () => {
  beforeEach(() => {
    reset();
  });

  it('默认 RAG 关闭 / provider=off', () => {
    const s = useKnowledgeStore.getState();
    expect(s.vectorRagEnabled).toBe(false);
    expect(s.embeddingProvider).toBe('off');
  });

  it('setVectorRagEnabled 切换', () => {
    useKnowledgeStore.getState().setVectorRagEnabled(true);
    expect(useKnowledgeStore.getState().vectorRagEnabled).toBe(true);
  });

  it('setVectorTopK 存整数值', () => {
    useKnowledgeStore.getState().setVectorTopK(8);
    expect(useKnowledgeStore.getState().vectorTopK).toBe(8);
  });

  it('setRagMaxInjectChars 存整数值', () => {
    useKnowledgeStore.getState().setRagMaxInjectChars(20_000);
    expect(useKnowledgeStore.getState().ragMaxInjectChars).toBe(20_000);
  });

  it('setEmbeddingProvider 切换 ollama / openai / off', () => {
    useKnowledgeStore.getState().setEmbeddingProvider('ollama');
    expect(useKnowledgeStore.getState().embeddingProvider).toBe('ollama');
    useKnowledgeStore.getState().setEmbeddingProvider('openai');
    expect(useKnowledgeStore.getState().embeddingProvider).toBe('openai');
    useKnowledgeStore.getState().setEmbeddingProvider('off');
    expect(useKnowledgeStore.getState().embeddingProvider).toBe('off');
  });

  it('setEmbeddingApiUrl / setEmbeddingApiKey / setEmbeddingModel 字段独立', () => {
    useKnowledgeStore.getState().setEmbeddingApiUrl('http://x:11434');
    useKnowledgeStore.getState().setEmbeddingApiKey('sk-x');
    useKnowledgeStore.getState().setEmbeddingModel('nomic-embed-text');
    expect(useKnowledgeStore.getState().embeddingApiUrl).toBe('http://x:11434');
    expect(useKnowledgeStore.getState().embeddingApiKey).toBe('sk-x');
    expect(useKnowledgeStore.getState().embeddingModel).toBe('nomic-embed-text');
  });

  it('setEmbeddingVolcMultimodal 切换', () => {
    useKnowledgeStore.getState().setEmbeddingVolcMultimodal(true);
    expect(useKnowledgeStore.getState().embeddingVolcMultimodal).toBe(true);
  });

  it('getEmbedConfigForIpc: off 时返 null', () => {
    expect(useKnowledgeStore.getState().getEmbedConfigForIpc()).toBeNull();
  });

  it('getEmbedConfigForIpc: openai + 必要字段齐时返配置', () => {
    useKnowledgeStore.getState().setEmbeddingProvider('openai');
    useKnowledgeStore.getState().setEmbeddingApiUrl('https://x');
    useKnowledgeStore.getState().setEmbeddingApiKey('k');
    useKnowledgeStore.getState().setEmbeddingModel('text-embedding-3-small');
    const cfg = useKnowledgeStore.getState().getEmbedConfigForIpc();
    expect(cfg).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'text-embedding-3-small',
    });
  });

  it('getEmbedConfigForIpc: ollama 时 apiKey 可空（本地默认无 key）', () => {
    useKnowledgeStore.getState().setEmbeddingProvider('ollama');
    useKnowledgeStore.getState().setEmbeddingApiUrl('http://127.0.0.1:11434');
    useKnowledgeStore.getState().setEmbeddingModel('nomic-embed-text');
    const cfg = useKnowledgeStore.getState().getEmbedConfigForIpc();
    expect(cfg?.provider).toBe('ollama');
    expect(cfg?.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('getEmbedConfigForIpc: 模型名 embedding-vision + 火山 URL 自动 volcMultimodal', () => {
    useKnowledgeStore.getState().setEmbeddingProvider('openai');
    useKnowledgeStore.getState().setEmbeddingApiUrl('https://ark.cn-beijing.volces.com/api/v3');
    useKnowledgeStore.getState().setEmbeddingModel('doubao-embedding-vision');
    const cfg = useKnowledgeStore.getState().getEmbedConfigForIpc();
    expect(cfg?.volcMultimodal).toBe(true);
  });

  it('getEmbedConfigForIpc: apiUrl 空时回退到 provider 默认 URL', () => {
    useKnowledgeStore.getState().setEmbeddingProvider('openai');
    useKnowledgeStore.getState().setEmbeddingModel('m');
    const cfg = useKnowledgeStore.getState().getEmbedConfigForIpc();
    expect(cfg?.baseUrl).toBe('https://api.openai.com/v1');
  });
});
