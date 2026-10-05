import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { ModelSettingsHub } from './ModelSettingsHub';
import { useModelStore } from '../../store/modelStore';
import { useConnectionStore } from '../../store/connectionStore';
import { useSettingStore } from '../../store/settingStore';
import type { ModelConfig } from '../../types';

vi.mock('../../store/confirmStore', () => ({ confirmDestructive: vi.fn(async () => true) }));

const chat: ModelConfig = { id: 'chat', name: 'Local chat', provider: 'ollama', modelName: 'gemma4', apiUrl: 'http://localhost:11434', isLocal: true, maxTokens: 4096 };
const image: ModelConfig = { id: 'image', name: 'Local image', provider: 'custom', modelName: '', apiUrl: '', isLocal: true, maxTokens: 4096, isChatModel: false, isImageGenerator: true, imageGeneratorConfig: { type: 'cli', command: 'fixture.py' } };
const video: ModelConfig = { id: 'video', name: 'My video', provider: 'custom', modelName: '', apiUrl: '', isLocal: false, maxTokens: 4096, isChatModel: false, isVideoGenerator: true, videoGeneratorConfig: { provider: 'minimax', model: 'MiniMax-Hailuo-02', apiKey: 'fixture-video-key' } };
beforeEach(() => {
  useSettingStore.setState({ locale: 'zh', streamResponses: true, speechInputEnabled: false, voiceWakeEnabled: false, voiceReplyEnabled: false, voiceReplyMode: 'auto' });
  useModelStore.setState({ models: [chat, image, video], activeModelId: chat.id, imageGenModelId: image.id, routingRules: [] });
  useConnectionStore.setState({ connections: [{ id: 'shared', name: 'Shared fixture', provider: 'custom', apiUrl: 'https://fixture.example/v1', apiKey: 'fixture-secret', chatApiMode: 'anthropic', updatedAt: 1 }], organizationSummary: { status: 'ready', services: 1, models: 1, organizedModels: 0, organizedServices: 0, skippedModels: 0 } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mount = (hardware = { systemTtsAvailable: true, microphoneMissing: false }) => render(<ModelSettingsHub cardShell="bg-white dark:bg-slate-900" {...hardware} />);
const panel = () => within(screen.getByRole('tabpanel'));
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name, exact: true }));

describe('unified model settings', () => {
  it('starts with configured models and exposes one visible panel with category counts', () => {
    mount();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByText('2 个对话 / 图片模型 · 1 个视频模型 · 1 个服务')).toBeInTheDocument();
    expect(panel().getByText('Local chat', { selector: 'span' })).toBeInTheDocument();
    expect(panel().getByText('Local image', { selector: 'span' })).toBeInTheDocument();
    expect(panel().queryByText('My video')).toBeNull();
    openTab('视频模型');
    expect(panel().getByText('My video')).toBeInTheDocument();
    openTab('服务连接');
    expect(panel().getByText('Shared fixture')).toBeInTheDocument();
    openTab('语音与回答');
    expect(panel().getByRole('switch', { name: '启用流式输出' })).toBeInTheDocument();
  });

  it('keeps a model draft across tabs and saves the retained edits', () => {
    mount();
    fireEvent.click(panel().getAllByRole('button', { name: '编辑', exact: true })[0]);
    fireEvent.change(panel().getByPlaceholderText('服务提供的模型名称'), { target: { value: 'gemma-draft' } });
    openTab('服务连接'); openTab('对话与图片');
    expect(panel().getByDisplayValue('gemma-draft')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: '保存', exact: true }));
    expect(useModelStore.getState().models.find(m => m.id === 'chat')?.modelName).toBe('gemma-draft');
  });

  it('reduces a linked model to service and model fields, and opens service management without losing its draft', () => {
    useModelStore.setState({ models: [{ ...chat, connectionId: 'shared', isLocal: false }], activeModelId: chat.id });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    expect(panel().getByLabelText('服务连接')).toHaveValue('shared');
    expect(panel().getByText('https://fixture.example/v1')).toBeInTheDocument();
    expect(panel().getByText('Anthropic Messages · A')).toBeInTheDocument();
    expect(panel().queryByRole('combobox', { name: '提供商 *' })).toBeNull();
    expect(panel().queryByRole('combobox', { name: '对话接口模式' })).toBeNull();
    expect(panel().queryByPlaceholderText('https://api.openai.com/v1')).toBeNull();
    expect(panel().queryByDisplayValue('fixture-secret')).toBeNull();
    fireEvent.change(panel().getByPlaceholderText('服务提供的模型名称'), { target: { value: 'shared-draft' } });
    fireEvent.click(panel().getByRole('button', { name: '管理服务' }));
    expect(screen.getByRole('tab', { name: '服务连接', exact: true })).toHaveAttribute('aria-selected', 'true');
    openTab('对话与图片');
    expect(panel().getByDisplayValue('shared-draft')).toBeInTheDocument();
  });

  it('exposes a missing service and editable fallback without silently detaching it', () => {
    useModelStore.setState({ models: [{ ...chat, connectionId: 'removed' }], activeModelId: chat.id });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    expect(panel().getByLabelText('服务连接')).toHaveValue('removed');
    expect(panel().getByRole('status')).toHaveTextContent('原服务连接已移除');
    expect(panel().getByRole('combobox', { name: '提供商 *' })).not.toBeDisabled();
    expect(panel().getByPlaceholderText('https://api.openai.com/v1')).not.toBeDisabled();
    expect(useModelStore.getState().models[0].connectionId).toBe('removed');
    fireEvent.change(panel().getByLabelText('服务连接'), { target: { value: '' } });
    fireEvent.change(panel().getByPlaceholderText('服务提供的模型名称'), { target: { value: 'retained-model' } });
    fireEvent.click(panel().getByRole('button', { name: '保存', exact: true }));
    expect(useModelStore.getState().models[0].connectionId).toBeUndefined();
    expect(useModelStore.getState().models[0].apiUrl).toBe(chat.apiUrl);
  });

  it('hides irrelevant chat connections for a local image script', () => {
    useModelStore.setState({ models: [image] });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    expect(panel().queryByLabelText('服务连接')).toBeNull();
    expect(panel().getByDisplayValue('fixture.py')).toBeInTheDocument();
  });

  it('keeps a CLI image model local and actually clears removed command-line arguments', () => {
    useModelStore.setState({ models: [{ ...image, imageGeneratorConfig: { ...image.imageGeneratorConfig!, cliArgLines: '--old-argument' } }] });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    fireEvent.click(panel().getByText('高级设置（可选）'));
    fireEvent.change(panel().getByLabelText(/命令行参数/), { target: { value: '' } });
    fireEvent.click(panel().getByRole('button', { name: '保存', exact: true }));
    expect(useModelStore.getState().models[0].isLocal).toBe(true);
    expect(useModelStore.getState().models[0].imageGeneratorConfig?.cliArgLines).toBeUndefined();
  });

  it('retains a shared key for an HTTP image-only model when saving its model ID', () => {
    useModelStore.setState({ models: [{ ...image, connectionId: 'shared', imageGeneratorConfig: { type: 'http', endpoint: 'https://images.example/v1/images/generations', httpFormat: 'openai_images', model: 'fixture-image', apiKeySource: 'connection' } }] });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    expect(panel().getByRole('checkbox', { name: '使用所选服务的密钥' })).toBeChecked();
    expect(panel().queryByDisplayValue('fixture-secret')).toBeNull();
    fireEvent.change(panel().getByDisplayValue('fixture-image'), { target: { value: 'image-edited' } });
    fireEvent.click(panel().getByRole('button', { name: '保存', exact: true }));
    const saved = useModelStore.getState().models[0];
    expect(saved.connectionId).toBe('shared');
    expect(saved.imageGeneratorConfig).toMatchObject({ model: 'image-edited', apiKeySource: 'connection' });
    expect(saved.imageGeneratorConfig?.apiKey).toBeUndefined();
    expect(saved.apiKey).toBe('fixture-secret');
  });

  it('preserves shared image authentication when changing a combined model to images only', () => {
    useModelStore.setState({ models: [{ ...chat, isImageGenerator: true, connectionId: 'shared', imageGeneratorConfig: { type: 'http', endpoint: 'https://images.example/v1/images/generations', model: 'fixture-image', apiKeySource: 'connection' } }] });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    fireEvent.change(panel().getByLabelText('用途'), { target: { value: 'image' } });
    expect(panel().getByRole('checkbox', { name: '使用所选服务的密钥' })).toBeChecked();
    fireEvent.click(panel().getByRole('button', { name: '保存', exact: true }));
    expect(useModelStore.getState().models[0]).toMatchObject({ isChatModel: false, connectionId: 'shared', imageGeneratorConfig: { apiKeySource: 'connection' } });
  });

  it('uses updated transport credentials after editing a service in another tab without losing the model draft', async () => {
    const call = vi.spyOn(window.electron, 'callModel').mockResolvedValue({ content: 'OK' });
    useModelStore.setState({ models: [{ ...chat, connectionId: 'shared', isLocal: false }] });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    fireEvent.change(panel().getByPlaceholderText('服务提供的模型名称'), { target: { value: 'draft-model' } });
    fireEvent.click(panel().getByRole('button', { name: '管理服务' }));
    fireEvent.click(panel().getByRole('button', { name: '编辑连接 Shared fixture' }));
    fireEvent.change(panel().getByLabelText('服务地址'), { target: { value: 'https://changed.example/v1' } });
    fireEvent.change(panel().getByLabelText('API Key'), { target: { value: 'updated-fixture-key' } });
    fireEvent.click(panel().getByRole('button', { name: '保存连接' }));
    openTab('对话与图片');
    expect(panel().getByDisplayValue('draft-model')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0][1]).toMatchObject({ apiUrl: 'https://changed.example/v1', apiKey: 'updated-fixture-key', modelName: 'draft-model' });
  });

  it('keeps the fresh fallback after deleting a service while a linked model draft is open', async () => {
    useModelStore.setState({ models: [{ ...chat, connectionId: 'shared', isLocal: false }] });
    mount(); fireEvent.click(panel().getByRole('button', { name: '编辑', exact: true }));
    fireEvent.change(panel().getByPlaceholderText('服务提供的模型名称'), { target: { value: 'detached-draft' } });
    openTab('服务连接');
    fireEvent.click(panel().getByRole('button', { name: '编辑连接 Shared fixture' }));
    fireEvent.change(panel().getByLabelText('API Key'), { target: { value: 'fresh-fallback-key' } });
    fireEvent.click(panel().getByRole('button', { name: '保存连接' }));
    fireEvent.click(panel().getByRole('button', { name: '删除连接 Shared fixture' }));
    await waitFor(() => expect(useConnectionStore.getState().connections).toHaveLength(0));
    openTab('对话与图片');
    expect(panel().getByLabelText('服务连接')).toHaveValue('');
    expect(panel().getByDisplayValue('fresh-fallback-key')).toBeInTheDocument();
    expect(panel().getByDisplayValue('detached-draft')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: '保存', exact: true }));
    expect(useModelStore.getState().models[0]).toMatchObject({ apiKey: 'fresh-fallback-key', modelName: 'detached-draft', apiUrl: 'https://fixture.example/v1' });
    expect(useModelStore.getState().models[0].connectionId).toBeUndefined();
  });

  it('preserves a service draft when navigating away and back', () => {
    mount(); openTab('服务连接');
    fireEvent.click(panel().getByRole('button', { name: '添加服务连接' }));
    fireEvent.change(panel().getByLabelText('连接名称'), { target: { value: 'New draft service' } });
    openTab('视频模型'); openTab('服务连接');
    expect(panel().getByLabelText('连接名称')).toHaveValue('New draft service');
    fireEvent.click(panel().getByRole('button', { name: '保存连接' }));
    expect(useConnectionStore.getState().connections.some(c => c.name === 'New draft service')).toBe(true);
  });

  it('keeps hardware guards and changes reply presentation, length and quick chat', () => {
    const quick = vi.spyOn(window.electron, 'showQuickPanel');
    mount({ systemTtsAvailable: false, microphoneMissing: true }); openTab('语音与回答');
    expect(panel().getByRole('switch', { name: '启用语音输入' })).toBeDisabled();
    expect(panel().getByRole('switch', { name: '朗读助手回复' })).toBeDisabled();
    fireEvent.click(panel().getByRole('switch', { name: '启用流式输出' }));
    expect(useSettingStore.getState().streamResponses).toBe(false);
    fireEvent.change(panel().getByLabelText('语音回答长度'), { target: { value: 'full' } });
    expect(useSettingStore.getState().voiceReplyMode).toBe('full');
    fireEvent.click(panel().getByRole('button', { name: '打开', exact: true }));
    expect(quick).toHaveBeenCalledOnce();
  });

  it('retains microphone, wake phrase, speech service and spoken reply controls in one page', () => {
    mount(); openTab('语音与回答');
    fireEvent.click(panel().getByRole('switch', { name: '启用语音输入' }));
    fireEvent.click(panel().getByRole('switch', { name: '语音唤醒' }));
    fireEvent.change(panel().getByLabelText('唤醒词'), { target: { value: '小助手' } });
    expect(useSettingStore.getState().voiceWakePhrase).toBe('小助手');
    fireEvent.click(panel().getByText('火山语音识别服务'));
    expect(panel().getByText(/App Key/)).toBeInTheDocument();
    fireEvent.click(panel().getByRole('switch', { name: '朗读助手回复' }));
    expect(useSettingStore.getState().voiceReplyEnabled).toBe(true);
    openTab('对话与图片'); openTab('语音与回答');
    expect(panel().getByLabelText('唤醒词')).toHaveValue('小助手');
  });

  it('supports keyboard tab navigation, English labels and migration status', () => {
    useSettingStore.setState({ locale: 'en' });
    useConnectionStore.setState({ organizationSummary: { status: 'ready', services: 1, models: 1, organizedServices: 1, organizedModels: 1, skippedModels: 0 } });
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Existing service settings organized');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat & images', exact: true }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Voice & reply', exact: true })).toHaveFocus();
    expect(panel().getByLabelText('Spoken answer length')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Voice & reply', exact: true }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Chat & images', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
});
