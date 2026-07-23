/** Settings → 模型编辑主路径（依赖 props 注入 t） */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ModelsSection } from './ModelsSection';
import { useModelStore } from '../../store/modelStore';
import { makeTFor, renderWithProviders } from '../../test/renderWithProviders';

function renderModels() {
  return renderWithProviders(
    <ModelsSection cardShell="bg-white dark:bg-slate-900" t={makeTFor('zh')} />
  );
}

describe('ModelsSection', () => {
  beforeEach(() => {
    useModelStore.setState({ models: [], activeModelId: null }, false);
  });

  it('expands and adds a model through the store', async () => {
    renderModels();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }));

    /** label 暂未用 htmlFor 关联（可访问性债，先用 placeholder 定位） */
    fireEvent.change(screen.getByPlaceholderText(/My GPT-4/), {
      target: { value: 'Smoke-Model' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/api\.openai\.com/), {
      target: { value: 'https://api.openai.com/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^gpt-4$|^llama3$/), {
      target: { value: 'gpt-4' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(useModelStore.getState().models.some((m) => m.name === 'Smoke-Model')).toBe(true);
    });
  });

  it('renders existing model and offers selection', () => {
    useModelStore.setState(
      {
        models: [
          {
            id: 'm1',
            name: 'Mock-GPT',
            provider: 'openai',
            apiUrl: 'https://x',
            apiKey: '',
            modelName: '',
            isLocal: false,
            maxTokens: 4096,
            isImageGenerator: false,
          },
        ],
        activeModelId: 'm1',
      },
      false
    );
    renderModels();
    expect(screen.queryByText('Mock-GPT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    expect(screen.getAllByText('Mock-GPT').length).toBeGreaterThan(0);
  });
});
