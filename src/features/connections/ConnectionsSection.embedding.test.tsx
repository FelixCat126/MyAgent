import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionsSection } from './ConnectionsSection';
import { useConnectionStore, type ServiceConnection } from '../../store/connectionStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { useModelStore } from '../../store/modelStore';
import { useSettingStore } from '../../store/settingStore';

vi.mock('../../store/confirmStore', () => ({ confirmDestructive: vi.fn(async () => true) }));
const service: ServiceConnection = { id: 'bailian', name: 'Bailian', provider: 'custom', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-fixture', chatApiMode: 'auto', updatedAt: 1 };

beforeEach(() => {
  useSettingStore.setState({ locale: 'zh' });
  useConnectionStore.setState({ connections: [service] });
  useModelStore.setState({ models: [], activeModelId: null, imageGenModelId: null, connectionMigrationVersion: 1 });
  useKnowledgeStore.setState({ embeddingProvider: 'openai', embeddingConnectionId: null, embeddingApiUrl: '', embeddingApiKey: 'independent-key', embeddingModel: 'text-embedding-v3' });
});
afterEach(() => cleanup());

describe('embedding settings when a service connection is deleted', () => {
  it('keeps the deleted service URL and key so retrieval keeps working', async () => {
    useKnowledgeStore.getState().setEmbeddingConnection(service.id);
    useConnectionStore.getState().saveConnection({ ...service, apiKey: 'sk-rotated' });
    render(<ConnectionsSection cardShell="fixture" />);
    fireEvent.click(screen.getByRole('button', { name: `删除连接 ${service.name}` }));
    await waitFor(() => expect(useConnectionStore.getState().connections).toHaveLength(0));
    const knowledge = useKnowledgeStore.getState();
    expect(knowledge.embeddingConnectionId).toBeNull();
    expect(knowledge.getEmbedConfigForIpc()).toMatchObject({ provider: 'openai', baseUrl: service.apiUrl, apiKey: 'sk-rotated', model: 'text-embedding-v3' });
  });

  it('falls back to the snapshot key even if the linked connection disappears elsewhere', () => {
    useKnowledgeStore.getState().setEmbeddingConnection(service.id);
    useConnectionStore.getState().removeConnection(service.id);
    expect(useKnowledgeStore.getState().getEmbedConfigForIpc()).toMatchObject({ baseUrl: service.apiUrl, apiKey: 'sk-fixture' });
  });

  it('switches to the provider default model when the linked service changes embedding protocol', () => {
    useConnectionStore.getState().saveConnection({ id: 'ollama', name: 'Ollama', provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', apiKey: '', chatApiMode: 'auto' });
    useKnowledgeStore.setState({ embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small' });
    useKnowledgeStore.getState().setEmbeddingConnection('ollama');
    expect(useKnowledgeStore.getState()).toMatchObject({ embeddingProvider: 'ollama', embeddingModel: 'nomic-embed-text' });
  });
});
