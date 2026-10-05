import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VideoModelsSection } from './VideoModelsSection';
import { ConnectionsSection } from './ConnectionsSection';
import { useModelStore } from '../../store/modelStore';
import { useConnectionStore, resolveModelConnection } from '../../store/connectionStore';
import { useSettingStore } from '../../store/settingStore';
import type { ModelConfig } from '../../types';

vi.mock('../../store/confirmStore', () => ({ confirmDestructive: vi.fn(async () => true) }));
const video: ModelConfig = { id: 'video', name: 'Video', provider: 'custom', apiUrl: 'https://legacy.example', modelName: 'MiniMax-Hailuo-02', isLocal: false, maxTokens: 4096, isChatModel: false, isVideoGenerator: true, videoGeneratorConfig: { provider: 'minimax', endpoint: 'https://api.minimaxi.com', apiKey: 'legacy-video-key', model: 'MiniMax-Hailuo-02', resolution: '768', duration: 6 } };
beforeEach(() => {
  cleanup();
  useSettingStore.setState({ locale: 'en' });
  useModelStore.setState({ models: [video], activeModelId: null });
  useConnectionStore.setState({ connections: [{ id: 'service', name: 'Shared service', provider: 'custom', apiUrl: 'https://shared.example/v1', apiKey: 'shared-key', chatApiMode: 'auto', updatedAt: 1 }] });
});

describe('video credential source and detachment', () => {
  it('switches an existing independent key to shared credentials in the actual editor', () => {
    render(<VideoModelsSection cardShell="" />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Credential source'), { target: { value: 'service' } });
    expect(screen.queryByDisplayValue('legacy-video-key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    const saved = useModelStore.getState().models[0];
    expect(saved.connectionId).toBeUndefined();
    expect(saved.videoGeneratorConfig?.connectionId).toBe('service');
    expect(saved.videoGeneratorConfig?.apiKey).toBeUndefined();
    expect(resolveModelConnection(saved).videoGeneratorConfig?.apiKey).toBe('shared-key');
  });

  it('keeps legacy independent video keys even when chat uses a shared service', () => {
    expect(resolveModelConnection(video).videoGeneratorConfig?.apiKey).toBe('legacy-video-key');
    expect(resolveModelConnection({ ...video, connectionId: 'service' }).videoGeneratorConfig?.apiKey).toBe('legacy-video-key');
  });

  it('renames a combined local chat/video model without clearing its independent key or changing chat settings', () => {
    const combined: ModelConfig = { ...video, isChatModel: true, isLocal: true, provider: 'ollama', apiUrl: 'http://localhost:11434', modelName: 'gemma4', connectionId: 'service' };
    useModelStore.setState({ models: [combined] });
    render(<VideoModelsSection cardShell="" />);
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Credential source')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).toHaveValue('legacy-video-key');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed video' } });
    fireEvent.click(screen.getByText('Save'));
    const saved = useModelStore.getState().models[0];
    expect(saved).toMatchObject({ name: 'Renamed video', isLocal: true, provider: 'ollama', apiUrl: combined.apiUrl, modelName: 'gemma4', connectionId: 'service' });
    expect(saved.videoGeneratorConfig?.apiKey).toBe('legacy-video-key');
    expect(saved.videoGeneratorConfig?.connectionId).toBeUndefined();
  });

  it('uses a different video service without changing the parent chat connection', () => {
    useConnectionStore.setState({ connections: [...useConnectionStore.getState().connections, { id: 'video-service', name: 'Video only', provider: 'custom', apiUrl: 'https://video.example/v1', apiKey: 'video-shared-key', chatApiMode: 'anthropic', updatedAt: 1 }] });
    const combined: ModelConfig = { ...video, isChatModel: true, modelName: 'chat-model', connectionId: 'service' };
    useModelStore.setState({ models: [combined] });
    render(<VideoModelsSection cardShell="" />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Credential source'), { target: { value: 'video-service' } });
    fireEvent.click(screen.getByText('Save'));
    const saved = useModelStore.getState().models[0];
    expect(saved.connectionId).toBe('service');
    expect(saved.videoGeneratorConfig?.connectionId).toBe('video-service');
    expect(saved.videoGeneratorConfig?.apiKey).toBeUndefined();
    const resolved = resolveModelConnection(saved);
    expect(resolved.apiUrl).toBe('https://shared.example/v1');
    expect(resolved.apiKey).toBe('shared-key');
    expect(resolved.modelName).toBe('chat-model');
    expect(resolved.videoGeneratorConfig?.apiKey).toBe('video-shared-key');
    expect(resolved.videoGeneratorConfig?.endpoint).toBe('https://api.minimaxi.com');
  });

  it('detaches only the deleted video service while retaining its key and the other chat connection', async () => {
    useConnectionStore.setState({ connections: [...useConnectionStore.getState().connections, { id: 'video-service', name: 'Video only', provider: 'custom', apiUrl: 'https://video.example/v1', apiKey: 'video-shared-key', updatedAt: 1 }] });
    useModelStore.setState({ models: [{ ...video, isChatModel: true, connectionId: 'service', videoGeneratorConfig: { ...video.videoGeneratorConfig!, connectionId: 'video-service', apiKey: undefined } }] });
    render(<ConnectionsSection cardShell="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Video only' }));
    await waitFor(() => expect(useConnectionStore.getState().connections).toHaveLength(1));
    const saved = useModelStore.getState().models[0];
    expect(saved.connectionId).toBe('service');
    expect(saved.videoGeneratorConfig?.connectionId).toBeUndefined();
    expect(saved.videoGeneratorConfig?.apiKey).toBe('video-shared-key');
    expect(saved.apiUrl).toBe(video.apiUrl);
    expect(saved.provider).toBe(video.provider);
    expect(saved.apiKey).toBe(video.apiKey);
    expect(resolveModelConnection(saved).apiKey).toBe('shared-key');
  });

  it('detaches a shared connection while retaining effective image and video credentials', async () => {
    useModelStore.setState({ models: [{ ...video, connectionId: 'service', isImageGenerator: true, imageGeneratorConfig: { type: 'http', endpoint: 'https://images.example/v1', apiKeySource: 'connection' } }] });
    render(<ConnectionsSection cardShell="" />);
    fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(useConnectionStore.getState().connections).toHaveLength(0));
    const detached = useModelStore.getState().models[0];
    expect(detached.connectionId).toBeUndefined();
    expect(detached.apiKey).toBe('shared-key');
    expect(detached.videoGeneratorConfig?.apiKey).toBe('legacy-video-key');
    expect(detached.imageGeneratorConfig?.apiKeySource).toBe('connection');
    expect(resolveModelConnection(detached)).toBe(detached);
  });
});
