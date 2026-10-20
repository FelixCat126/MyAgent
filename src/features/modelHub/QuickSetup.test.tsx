import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuickSetup } from './QuickSetup';
import { buildSetupPlan, classifyModelId, getVendorPreset } from './vendorCatalog';
import { applySetup, upsertVendorConnection } from './quickSetupApply';
import { useModelStore } from '../../store/modelStore';
import { useConnectionStore } from '../../store/connectionStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { useSettingStore } from '../../store/settingStore';

beforeEach(() => {
  useSettingStore.setState({ locale: 'zh' });
  useModelStore.setState({ models: [], activeModelId: null, imageGenModelId: null, routingRules: [] });
  useConnectionStore.setState({ connections: [] });
  useKnowledgeStore.setState({ embeddingProvider: 'off', embeddingConnectionId: null, embeddingApiKey: 'old-key', embeddingApiUrl: 'https://api.openai.com/v1', embeddingModel: 'text-embedding-3-small' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('vendor catalog', () => {
  it('classifies model IDs by name', () => {
    expect(classifyModelId('gpt-4o')).toBe('chat');
    expect(classifyModelId('gpt-image-1')).toBe('image');
    expect(classifyModelId('text-embedding-3-small')).toBe('embedding');
    expect(classifyModelId('nomic-embed-text:latest')).toBe('embedding');
    expect(classifyModelId('whisper-1')).toBe('audio');
    expect(classifyModelId('doubao-seedance-1-0-pro')).toBe('video');
    expect(classifyModelId('omni-moderation-latest')).toBe('other');
  });

  it('picks preferred defaults and falls back to preset image models', () => {
    const plan = buildSetupPlan(getVendorPreset('openai')!, ['whisper-1', 'gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small', 'text-embedding-3-large']);
    expect(plan.chatCandidates).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(plan.chatModel).toBe('gpt-4o');
    expect(plan.image).toMatchObject({ provider: 'openai-images', model: 'gpt-image-1' });
    expect(plan.embeddingModel).toBe('text-embedding-3-small');
  });

  it('leaves the chat model empty when the list is unavailable', () => {
    expect(buildSetupPlan(getVendorPreset('deepseek')!, []).chatModel).toBe('');
  });
});

describe('applySetup', () => {
  it('creates one shared connection and links chat, image and embeddings to it', () => {
    const vendor = getVendorPreset('bailian')!;
    const connection = upsertVendorConnection(vendor, vendor.apiUrl, 'sk-fixture');
    const plan = buildSetupPlan(vendor, ['qwen-plus', 'text-embedding-v3']);
    applySetup(vendor, connection, { chatModel: plan.chatModel, image: plan.image, embeddingModel: plan.embeddingModel });
    const { models, activeModelId, imageGenModelId } = useModelStore.getState();
    expect(models).toHaveLength(2);
    expect(models.find(m => m.id === activeModelId)).toMatchObject({ modelName: 'qwen-plus', connectionId: connection.id });
    expect(models.find(m => m.id === imageGenModelId)?.imageGeneratorConfig).toMatchObject({ provider: 'bailian-wanx', apiKeySource: 'connection' });
    expect(useKnowledgeStore.getState().getEmbedConfigForIpc()).toMatchObject({ provider: 'openai', baseUrl: vendor.apiUrl, apiKey: 'sk-fixture', model: 'text-embedding-v3' });
  });

  it('reuses the same connection and models when run twice', () => {
    const vendor = getVendorPreset('deepseek')!;
    applySetup(vendor, upsertVendorConnection(vendor, vendor.apiUrl, 'first'), { chatModel: 'deepseek-chat' });
    const connection = upsertVendorConnection(vendor, `${vendor.apiUrl}/`, 'second');
    applySetup(vendor, connection, { chatModel: 'deepseek-chat' });
    expect(useConnectionStore.getState().connections).toHaveLength(1);
    expect(useConnectionStore.getState().connections[0].apiKey).toBe('second');
    expect(useModelStore.getState().models).toHaveLength(1);
  });

  it('follows key changes on the linked connection for embeddings', () => {
    const vendor = getVendorPreset('zhipu')!;
    const connection = upsertVendorConnection(vendor, vendor.apiUrl, 'before');
    applySetup(vendor, connection, { chatModel: 'glm-4-plus', embeddingModel: 'embedding-3' });
    useConnectionStore.getState().saveConnection({ ...connection, apiKey: 'after' });
    expect(useKnowledgeStore.getState().getEmbedConfigForIpc()?.apiKey).toBe('after');
  });
});

describe('QuickSetup', () => {
  it('configures a vendor from a key and runs a chat check', async () => {
    const discover = vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] });
    const diagnose = vi.spyOn(window.electron, 'diagnoseModel').mockResolvedValue({ checkedAt: 1, checks: [{ kind: 'chat', status: 'verified' }] });
    render(<QuickSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: '读取模型并配置' }));
    await screen.findByRole('button', { name: '完成配置' });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' }));
    expect(screen.getByLabelText('对话模型')).toHaveValue('deepseek-chat');
    fireEvent.click(screen.getByRole('button', { name: '完成配置' }));
    await waitFor(() => expect(screen.getByText('对话测试通过')).toBeInTheDocument());
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'deepseek-chat', apiKey: 'sk-test' }), ['chat']);
    expect(useConnectionStore.getState().connections[0]).toMatchObject({ name: 'DeepSeek', apiKey: 'sk-test' });
  });

  it('allows a manual model name when the model list is unavailable', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [], error: '当前端点未提供模型列表接口' });
    render(<QuickSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'MiniMax' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'mm-key' } });
    fireEvent.click(screen.getByRole('button', { name: '读取模型并配置' }));
    const input = await screen.findByPlaceholderText('服务提供的模型名称');
    expect(screen.getByRole('status')).toHaveTextContent('未能读取模型列表');
    fireEvent.change(input, { target: { value: 'MiniMax-M2' } });
    fireEvent.click(screen.getByRole('button', { name: '完成配置' }));
    await waitFor(() => expect(useModelStore.getState().models.some(m => m.isVideoGenerator)).toBe(true));
    expect(useModelStore.getState().models.some(m => m.modelName === 'MiniMax-M2')).toBe(true);
  });

  it('asks local channels to start the service when no models are installed', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [] });
    render(<QuickSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }));
    expect(screen.getByLabelText('服务地址')).toHaveValue('http://127.0.0.1:11434');
    fireEvent.click(screen.getByRole('button', { name: '读取模型并配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本机服务没有返回模型');
  });
});
