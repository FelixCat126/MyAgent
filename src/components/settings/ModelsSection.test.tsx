/** Settings → 模型编辑主路径（依赖 props 注入 t） */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ModelsSection } from './ModelsSection';
import { useModelStore } from '../../store/modelStore';
import { makeTFor, renderWithProviders } from '../../test/renderWithProviders';
import { useErrorStore } from '../../store/errorStore';

function renderModels() {
  return renderWithProviders(
    <ModelsSection cardShell="bg-white dark:bg-slate-900" t={makeTFor('zh')} />
  );
}

describe('ModelsSection', () => {
  beforeEach(() => {
    useModelStore.setState({ models: [], activeModelId: null }, false);
    useErrorStore.getState().clear();
    vi.restoreAllMocks();
  });

  it('expands and adds a model through the store', async () => {
    renderModels();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }));

    fireEvent.click(screen.getByText('高级设置（可选）'));
    /** label 暂未用 htmlFor 关联（可访问性债，先用 placeholder 定位） */
    fireEvent.change(screen.getByPlaceholderText(/My GPT-4/), {
      target: { value: 'Smoke-Model' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/api\.openai\.com/), {
      target: { value: 'https://api.openai.com/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('服务提供的模型名称'), {
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

  it('在基础配置中直接提供 A / O 协议选择并保存', async () => {
    renderModels();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }));

    const protocol = screen.getByRole('combobox', { name: '对话接口模式' });
    expect(within(protocol).getByRole('option', { name: /Anthropic Messages/ })).toBeTruthy();
    expect(screen.getByText(/当前识别为 OpenAI Chat Completions/)).toBeTruthy();
    fireEvent.change(protocol, { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/api\.openai\.com/), {
      target: { value: 'https://gateway.example/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('服务提供的模型名称'), {
      target: { value: 'vendor-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(useModelStore.getState().models[0]?.chatApiMode).toBe('anthropic');
    });
  });

  it('远程对话模型可在保存前测试连接，并使用短请求', async () => {
    const callModel = vi.spyOn(window.electron, 'callModel').mockResolvedValue({ content: 'OK' });
    renderModels();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }));
    fireEvent.change(screen.getByPlaceholderText('服务提供的模型名称'), {
      target: { value: 'remote-model' },
    });

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(callModel).toHaveBeenCalledOnce());
    const [, config, options] = callModel.mock.calls[0];
    expect(config.maxTokens).toBe(32);
    expect(options).toMatchObject({ connectionTest: true, locale: 'zh' });
    await waitFor(() => {
      expect(useErrorStore.getState().items.at(-1)?.key).toBe('settings.form.connectionTestSuccess');
    });
  });

  it('本地 Ollama 配置不显示远程连接测试按钮', () => {
    renderModels();
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }));
    fireEvent.change(screen.getByRole('combobox', { name: '提供商 *' }), {
      target: { value: 'ollama' },
    });
    expect(screen.queryByRole('button', { name: '测试连接' })).toBeNull();
  });
});

it('adds an image-only connection with a preset and automatic name', async () => {
 useModelStore.setState({models:[],activeModelId:null});
 renderModels();
 fireEvent.click(screen.getByRole('button',{name:/展开模型配置/}));
 fireEvent.click(screen.getByRole('button',{name:/添加模型/}));
 fireEvent.change(screen.getByLabelText('用途'),{target:{value:'image'}});
 fireEvent.change(screen.getByLabelText('图片服务'),{target:{value:'openai-images'}});
 expect(screen.queryByPlaceholderText('服务提供的模型名称')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(useModelStore.getState().models).toHaveLength(1));
 const m=useModelStore.getState().models[0];
 expect(m.isChatModel).toBe(false);
 expect(m.name).toBe('gpt-image-1');
 expect(m.imageGeneratorConfig?.endpoint).toBe('https://api.openai.com/v1/images/generations');
 expect(useModelStore.getState().getActiveModel()).toBeNull();
});

it('clears an independent image key while preserving unrelated video settings', async () => {
 useModelStore.setState({models:[{id:'x',name:'image',provider:'custom',apiUrl:'',modelName:'',isLocal:false,maxTokens:4096,isChatModel:false,isImageGenerator:true,imageGeneratorConfig:{type:'http',endpoint:'https://example.com/images/generations',apiKey:'old-test-key',model:'image',apiKeySource:'independent'},isVideoGenerator:true,videoGeneratorConfig:{provider:'minimax',model:'video-test'}}],activeModelId:null});
 renderModels();
 fireEvent.click(screen.getByRole('button',{name:/展开模型配置/}));
 fireEvent.click(screen.getByRole('button',{name:'编辑'}));
 fireEvent.change(screen.getByLabelText('API 密钥'),{target:{value:''}});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(useModelStore.getState().models[0].imageGeneratorConfig?.apiKey).toBeUndefined());
 expect(useModelStore.getState().models[0].videoGeneratorConfig?.model).toBe('video-test');
});
