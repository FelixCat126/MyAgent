import type { ModelConfig } from '../../types';
import { useConnectionStore, resolveModelConnection, type ServiceConnection } from '../../store/connectionStore';
import { useModelStore } from '../../store/modelStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import type { SetupPlan, VendorPreset } from './vendorCatalog';

export interface SetupSelection {
  chatModel: string;
  image?: SetupPlan['image'];
  embeddingModel?: string;
  video?: SetupPlan['video'];
}

export interface SetupResult {
  connection: ServiceConnection;
  chatModelId?: string;
  imageModelId?: string;
  videoModelId?: string;
  embedding: boolean;
}

const sameEndpoint = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/** Reuse a service with the same address so repeated setup only refreshes its key. */
export function upsertVendorConnection(vendor: VendorPreset, apiUrl: string, apiKey: string): ServiceConnection {
  const store = useConnectionStore.getState();
  const existing = store.connections.find(c => c.provider === vendor.provider && sameEndpoint(c.apiUrl, apiUrl));
  const value = {
    ...(existing ?? {}),
    id: existing?.id ?? crypto.randomUUID(),
    name: existing?.name ?? vendor.name,
    provider: vendor.provider,
    apiUrl,
    apiKey,
    chatApiMode: existing?.chatApiMode ?? vendor.chatApiMode ?? 'auto',
    isLocal: vendor.kind === 'local',
  };
  store.saveConnection(value);
  return useConnectionStore.getState().connections.find(c => c.id === value.id)!;
}

function linkedModel(connection: ServiceConnection, patch: Partial<ModelConfig> & Pick<ModelConfig, 'name' | 'modelName'>): ModelConfig {
  return resolveModelConnection({
    id: crypto.randomUUID(),
    connectionId: connection.id,
    provider: connection.provider,
    apiUrl: connection.apiUrl,
    apiKey: connection.apiKey,
    chatApiMode: connection.chatApiMode,
    isLocal: connection.isLocal ?? false,
    maxTokens: 4096,
    ...patch,
  });
}

export function applySetup(vendor: VendorPreset, connection: ServiceConnection, selection: SetupSelection): SetupResult {
  const models = useModelStore.getState();
  const linked = models.models.filter(m => m.connectionId === connection.id);
  const result: SetupResult = { connection, embedding: false };

  const chatName = selection.chatModel.trim();
  if (chatName) {
    const existing = linked.find(m => m.isChatModel !== false && m.modelName.trim() === chatName);
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) models.addModel(linkedModel(connection, { id, name: chatName, modelName: chatName, isChatModel: true }));
    useModelStore.getState().setActiveModel(id);
    result.chatModelId = id;
  }

  const image = selection.image;
  if (image?.model.trim()) {
    const model = image.model.trim();
    const existing = linked.find(m => m.isImageGenerator && m.imageGeneratorConfig?.model === model);
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      useModelStore.getState().addModel(linkedModel(connection, {
        id, name: `${vendor.name} · ${model}`, modelName: '', isChatModel: false, isImageGenerator: true,
        imageGeneratorConfig: { type: 'http', provider: image.provider, endpoint: image.endpoint, model, httpFormat: image.httpFormat, apiKeySource: 'connection' },
      }));
    }
    useModelStore.getState().setImageGenModel(id);
    result.imageModelId = id;
  }

  const video = selection.video;
  if (video?.model.trim()) {
    const model = video.model.trim();
    const existing = useModelStore.getState().models.find(m => m.isVideoGenerator && m.videoGeneratorConfig?.connectionId === connection.id && m.videoGeneratorConfig.model === model);
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      useModelStore.getState().addModel(linkedModel(connection, {
        id, name: `${vendor.name} · ${model}`, modelName: '', isChatModel: false, isVideoGenerator: true,
        videoGeneratorConfig: { connectionId: connection.id, provider: 'minimax', endpoint: video.endpoint, model, resolution: '768', duration: 6 },
      }));
    }
    result.videoModelId = id;
  }

  const embeddingModel = selection.embeddingModel?.trim();
  if (embeddingModel) {
    const knowledge = useKnowledgeStore.getState();
    knowledge.setEmbeddingConnection(connection.id);
    knowledge.setEmbeddingModel(embeddingModel);
    result.embedding = true;
  }
  return result;
}
