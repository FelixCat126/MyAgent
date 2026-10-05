import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionsSection } from './ConnectionsSection';
import { useConnectionStore, type ServiceConnection } from '../../store/connectionStore';
import { useModelStore } from '../../store/modelStore';
import { useSettingStore } from '../../store/settingStore';
import type { ModelConfig } from '../../types';

vi.mock('../../store/confirmStore', () => ({ confirmDestructive: vi.fn(async () => true) }));
const connection: ServiceConnection = { id: 'mimo', name: 'MiMo', provider: 'custom', apiUrl: 'https://api.xiaomimimo.com/anthropic', apiKey: 'fixture-only', chatApiMode: 'anthropic', updatedAt: 1 };
const existing: ModelConfig = { id: 'existing', name: 'My MiMo', provider: 'custom', apiUrl: connection.apiUrl, apiKey: connection.apiKey, modelName: 'mimo-v2-pro', connectionId: connection.id, chatApiMode: 'anthropic', maxTokens: 8192, isLocal: false };
type Result = Awaited<ReturnType<typeof window.electron.discoverServiceModels>>;
const mount = () => render(<ConnectionsSection cardShell="fixture" />);
const discover = () => fireEvent.click(screen.getByRole('button', { name: '发现模型' }));
const deferred = () => {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  useSettingStore.setState({ locale: 'zh' });
  useConnectionStore.setState({ connections: [connection] });
  useModelStore.setState({ models: [existing], activeModelId: existing.id, imageGenModelId: null, connectionMigrationVersion: 1 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('service model discovery', () => {
  it('preselects and marks existing models, and adds only new choices without rewriting existing settings', async () => {
    const list = vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: 'mimo-v2-pro' }, { id: 'mimo-v2-flash' }] });
    mount(); discover();
    const added = await screen.findByRole('checkbox', { name: 'mimo-v2-pro' });
    expect(added).toBeChecked(); expect(added).toBeDisabled();
    expect(screen.getByText('已添加')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('共 2 个模型 · 已添加 1 个 · 待添加 0 个');
    expect(screen.getByRole('button', { name: '添加选中模型' })).toBeDisabled();
    const next = screen.getByRole('checkbox', { name: 'mimo-v2-flash' });
    expect(next).not.toBeChecked(); fireEvent.click(next);
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个模型' }));
    const saved = useModelStore.getState();
    expect(saved.models).toHaveLength(2); expect(saved.models[0]).toEqual(existing);
    expect(saved.models[1]).toMatchObject({ modelName: 'mimo-v2-flash', connectionId: connection.id, chatApiMode: 'anthropic', apiKey: connection.apiKey });
    expect(saved.activeModelId).toBe(existing.id);
    expect(list).toHaveBeenCalledWith(connection);
  });

  it('scopes added status to the selected service even when another service uses the same model ID', async () => {
    useModelStore.setState({ models: [{ ...existing, connectionId: 'different-service' }] });
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: existing.modelName }] });
    mount(); discover();
    expect(await screen.findByRole('checkbox', { name: existing.modelName })).not.toBeChecked();
    expect(screen.queryByText('已添加')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: existing.modelName }));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个模型' }));
    expect(useModelStore.getState().models.map(m => m.connectionId)).toEqual(['different-service', connection.id]);
  });

  it('keeps an all-added result visible with a disabled import action', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: existing.modelName }] });
    mount(); discover();
    expect(await screen.findByRole('checkbox', { name: existing.modelName })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('已添加 1 个 · 待添加 0 个');
    expect(screen.getByRole('button', { name: '添加选中模型' })).toBeDisabled();
  });

  it('normalizes duplicate and blank IDs before counting or importing', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: ' mimo-v2-pro ' }, { id: 'mimo-v2-pro' }, { id: '' }, { id: '  ' }, { id: 'new' }, { id: 'new' }] });
    mount(); discover();
    await screen.findByRole('checkbox', { name: existing.modelName });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('共 2 个模型');
  });

  it.each([
    { models: [] },
    { models: [{ id: ' ' }] },
  ])('keeps a usable empty-result explanation and retry action visible (%j)', async result => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue(result);
    mount(); discover();
    expect(await screen.findByRole('alert')).toHaveTextContent('服务没有返回可用模型列表');
    expect(screen.getByRole('button', { name: '重试发现' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
    expect(screen.getByText('MiMo')).toBeInTheDocument();
    expect(useModelStore.getState().models).toEqual([existing]);
  });

  it('shows a backend error until the user retries, then renders the successful result', async () => {
    const list = vi.spyOn(window.electron, 'discoverServiceModels')
      .mockResolvedValueOnce({ models: [], error: '模型列表接口不存在 (404)，请检查服务地址。' })
      .mockResolvedValueOnce({ models: [{ id: existing.modelName }] });
    mount(); discover();
    expect(await screen.findByRole('alert')).toHaveTextContent('模型列表接口不存在 (404)');
    fireEvent.click(screen.getByRole('button', { name: '重试发现' }));
    expect(await screen.findByRole('checkbox', { name: existing.modelName })).toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull(); expect(list).toHaveBeenCalledTimes(2);
  });

  it('handles rejected IPC and blank error messages without returning silently to the service list', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockRejectedValue(new Error(''));
    mount(); discover();
    expect(await screen.findByRole('alert')).toHaveTextContent('发现模型失败');
    expect(screen.getByRole('button', { name: '重试发现' })).toBeEnabled();
  });

  it('keeps loading visible and ignores a late result after returning to the service list', async () => {
    const request = deferred();
    vi.spyOn(window.electron, 'discoverServiceModels').mockReturnValue(request.promise);
    mount(); discover();
    expect(screen.getByRole('status')).toHaveTextContent('正在读取模型列表');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await act(async () => request.resolve({ models: [{ id: 'late-model' }] }));
    expect(screen.getByRole('button', { name: '发现模型' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('does not let an earlier request overwrite a later discovery', async () => {
    const earlier = deferred();
    vi.spyOn(window.electron, 'discoverServiceModels').mockReturnValueOnce(earlier.promise).mockResolvedValueOnce({ models: [{ id: 'current-model' }] });
    mount(); discover(); fireEvent.click(screen.getByRole('button', { name: '返回' })); discover();
    await screen.findByRole('checkbox', { name: 'current-model' });
    await act(async () => earlier.resolve({ models: [{ id: 'obsolete-model' }] }));
    expect(screen.queryByRole('checkbox', { name: 'obsolete-model' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'current-model' })).toBeInTheDocument();
  });

  it('refreshes added status if models change while the discovery panel is open', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: 'new-model' }] });
    mount(); discover(); const item = await screen.findByRole('checkbox', { name: 'new-model' });
    fireEvent.click(item);
    act(() => useModelStore.getState().addModel({ ...existing, id: 'added-elsewhere', modelName: 'new-model' }));
    expect(item).toBeChecked(); expect(item).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加选中模型' })).toBeDisabled();
    expect(useModelStore.getState().models).toHaveLength(2);
  });

  it('invalidates in-flight discovery when credentials change and retries with the fresh connection', async () => {
    const request = deferred();
    const list = vi.spyOn(window.electron, 'discoverServiceModels').mockReturnValueOnce(request.promise).mockResolvedValueOnce({ models: [{ id: 'fresh-model' }] });
    mount(); discover();
    const changed = { ...connection, apiKey: 'updated-fixture-only' };
    act(() => useConnectionStore.setState({ connections: [changed] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('服务配置已变更');
    await act(async () => request.resolve({ models: [{ id: 'stale-model' }] }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试发现' }));
    await screen.findByRole('checkbox', { name: 'fresh-model' });
    expect(list).toHaveBeenLastCalledWith(changed);
  });

  it('does not import from a connection removed while discovery is open', async () => {
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: 'new-model' }] });
    mount(); discover(); await screen.findByRole('checkbox', { name: 'new-model' });
    act(() => useConnectionStore.setState({ connections: [] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('服务连接已删除');
    expect(screen.getByRole('button', { name: '重试发现' })).toBeDisabled();
    expect(useModelStore.getState().models).toEqual([existing]);
  });

  it('retains the service local policy on newly imported models', async () => {
    useConnectionStore.setState({ connections: [{ ...connection, isLocal: true }] });
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValue({ models: [{ id: 'new-model' }] });
    mount(); discover(); fireEvent.click(await screen.findByRole('checkbox', { name: 'new-model' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个模型' }));
    expect(useModelStore.getState().models.at(-1)?.isLocal).toBe(true);
  });

  it('shows added status and persistent error feedback in English', async () => {
    useSettingStore.setState({ locale: 'en' });
    vi.spyOn(window.electron, 'discoverServiceModels').mockResolvedValueOnce({ models: [{ id: existing.modelName }] }).mockResolvedValueOnce({ models: [] });
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    expect(await screen.findByRole('checkbox', { name: existing.modelName })).toBeChecked();
    expect(screen.getByText('Added')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No usable model list'));
    expect(screen.getByRole('button', { name: 'Retry discovery' })).toBeEnabled();
  });
});
