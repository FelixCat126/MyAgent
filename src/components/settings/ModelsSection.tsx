import { useSettingStore } from '../../store/settingStore';
/**
 * 模型配置区：模型列表（增删改）+ 编辑表单（基础信息 + 生图工具高级配置）+ 生图模型独立选择。
 *
 * 抽离自 SettingsPanel.tsx（aria-labelledby="settings-models-heading" 的 <section>），
 * 行为与拆分前完全一致。
 *
 * 状态拆分原则：
 *  - store 派生量（models / imageGenModelId 等）→ 本组件自己调 useModelStore
 *  - 折叠态、编辑表单 state（modelBlockExpanded / showForm / editingId / formData）→ 本组件内部 useState
 *  - 表单派生 handler（startAdd / startEdit / handleSave）→ 本组件内部 useCallback
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  FORM_INPUT_LG,
} from './styleConstants';
import {
  FiCpu,
  FiChevronUp,
  FiChevronDown,
  FiSave,
  FiEdit2,
  FiTrash2,
  FiPlus,
  FiWifi,
  FiLoader,
} from 'react-icons/fi';
import { useModelStore, modelHasUsableImageGenerator } from '../../store/modelStore';
import { confirmDestructive } from '../../store/confirmStore';
import { showError, showSuccess, showWarning } from '../../store/errorStore';
import { ModelConfig } from '../../types';
import { BUILTIN_ROUTING_RULES, type RoutingRule } from '../../agent/modelRouting';
import {
  IMAGE_PROVIDER_PRESETS,
  getImageProviderPreset,
  getPresetDefaults,
  resolveImageProviderId,
  type ImageProviderId,
} from '../../../electron/shared/imageProviderPresets';
import { resolveChatApiMode } from '../../utils/chatApiMode';

/** 编辑表单数据结构（原 SettingsPanel.tsx 模块作用域 type，移入本组件以避免跨模块依赖） */
export type EditingFormData = {
  name: string;
  isChatModel?: boolean;
  contextWindowTokens?: number;
  imageKeySource?: 'connection' | 'independent';
  promptLanguage?: 'auto' | 'en';
  imageQuality?: 'auto' | 'low' | 'medium' | 'high';
  provider: ModelConfig['provider'];
  apiUrl: string;
  apiKey: string;
  modelName: string;
  chatApiMode: NonNullable<ModelConfig['chatApiMode']>;
  isLocal: boolean;
  maxTokens: number;
  isImageGenerator: boolean;
  imageGenType: string;
  imageGenCommand: string;
  imageGenEndpoint: string;
  imageGenEnv: string;
  imageGenHttpFormat: 'auto' | 'sdwebui' | 'ollama' | 'openai_images' | 'raw';
  imageGenCliArgLines: string;
  /** 生图厂商预设（新）；custom = 自定义 */
  imageGenProvider: ImageProviderId | '';
  /** 结构化生图 API Key（新）；优先于 env */
  imageGenApiKey: string;
  /** 结构化生图模型名（新）；优先于 env */
  imageGenModel: string;
};

/** 默认表单数据（原 SettingsPanel.tsx 模块作用域常量） */
export const defaultFormData: EditingFormData = {
  name: '',
  isChatModel: true,
  imageKeySource: 'independent',
  imageQuality: 'auto',
  provider: 'openai',
  apiUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: '',
  chatApiMode: 'auto',
  isLocal: false,
  maxTokens: 4096,
  isImageGenerator: false,
  imageGenType: 'http',
  imageGenCommand: '',
  imageGenEndpoint: '',
  imageGenEnv: '',
  imageGenHttpFormat: 'auto',
  imageGenCliArgLines: '',
  imageGenProvider: '',
  imageGenApiKey: '',
  imageGenModel: '',
};

/** 解析 KEY=VALUE 多行为 env map */
function parseEnvMap(text: string): Record<string, string> {
  const envMap: Record<string, string> = {};
  const envLines = text.trim().split('\n');
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) envMap[k] = v;
    }
  }
  return envMap;
}

/** 校验生图工具配置（原 SettingsPanel.tsx 模块作用域函数，移入本组件） */
function validateImageGeneratorForm(form: EditingFormData, envMap: Record<string, string>): string | null {
  if (!form.isImageGenerator) return null;
  if (form.imageGenType === 'cli') {
    if (!form.imageGenCommand.trim()) return '启用生图工具后，CLI 命令不能为空。';
    return null;
  }
  if (form.imageGenType === 'http') {
    if (!form.imageGenEndpoint.trim()) return '启用 HTTP 生图后，接口地址不能为空。';
    if (!/^https?:\/\//i.test(form.imageGenEndpoint.trim())) {
      return '启用 HTTP 生图后，接口地址必须以 http:// 或 https:// 开头。';
    }
    if (
      form.imageGenHttpFormat === 'ollama' &&
      !form.imageGenModel.trim() &&
      !envMap.OLLAMA_MODEL &&
      !envMap.MODEL &&
      !envMap.MODEL_ID
    ) {
      return 'Ollama HTTP 生图必须在环境变量里填写 OLLAMA_MODEL=你的模型标签。';
    }
    return null;
  }
  return '生图工具类型无效。';
}

export interface ModelsSectionProps {
  /** 卡片外壳 CSS（父组件常量） */
  cardShell: string;
  /** i18n 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const ModelsSection: React.FC<ModelsSectionProps> = ({ cardShell, t }) => {
  const locale = useSettingStore(state => state.locale);
  const label = (zh: string, en: string) => locale === 'zh' ? zh : en;
  // store 派生量本组件自己消费
  const {
    models,
    addModel,
    updateModel,
    removeModel,
    imageGenModelId,
    setImageGenModel,
    routingRules,
    setRoutingRules,
  } = useModelStore();

  const effectiveRoutingRules = useMemo(() => {
    if (routingRules.length > 0) return routingRules;
    return BUILTIN_ROUTING_RULES;
  }, [routingRules]);

  const updateRoutingPrefer = useCallback(
    (ruleId: string, preferModelId: string) => {
      const base: RoutingRule[] =
        routingRules.length > 0
          ? routingRules
          : BUILTIN_ROUTING_RULES.map((r) => ({ ...r }));
      setRoutingRules(
        base.map((r) => (r.id === ruleId ? { ...r, preferModelId } : r))
      );
    },
    [routingRules, setRoutingRules]
  );

  // 本组件内部状态：折叠态 + 编辑表单
  const [modelBlockExpanded, setModelBlockExpanded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<EditingFormData>(defaultFormData);
  const [testingConnection, setTestingConnection] = useState(false);

  /** 生图厂商解析：formData 三要素派生一次，表单内多处提示复用（曾每渲染重复调用 4 次） */
  const resolvedImageProvider = useMemo(
    () =>
      resolveImageProviderId(
        formData.imageGenProvider,
        formData.imageGenEndpoint,
        formData.imageGenHttpFormat
      ),
    [formData.imageGenProvider, formData.imageGenEndpoint, formData.imageGenHttpFormat]
  );
  const resolvedChatApiMode = useMemo(
    () => resolveChatApiMode(formData),
    [formData.apiUrl, formData.chatApiMode, formData.modelName, formData.provider]
  );
  const isLocalChatConfig =
    formData.provider === 'ollama' ||
    /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(formData.apiUrl.trim());
  const canTestRemoteChat = formData.isChatModel !== false && !isLocalChatConfig;

  const startAdd = useCallback(() => {
    setEditingId(null);
    setFormData(defaultFormData);
    setShowForm(true);
  }, []);

  const startEdit = useCallback((model: ModelConfig) => {
    setEditingId(model.id);
    setFormData({
      name: model.name,
      isChatModel: model.isChatModel !== false,
      contextWindowTokens: model.contextWindowTokens,
      imageKeySource: model.imageGeneratorConfig?.apiKeySource ?? (model.imageGeneratorConfig?.apiKey ? 'independent' : 'connection'),
      imageQuality: model.imageGeneratorConfig?.quality || 'auto',
      promptLanguage: model.imageGeneratorConfig?.promptLanguage,
      provider: model.provider,
      apiUrl: model.apiUrl,
      apiKey: model.apiKey || '',
      modelName: model.modelName,
      chatApiMode: model.chatApiMode || 'auto',
      isLocal: model.isLocal,
      maxTokens: model.maxTokens,
      isImageGenerator: model.isImageGenerator || false,
      imageGenType: model.imageGeneratorConfig?.type || 'http',
      imageGenCommand: model.imageGeneratorConfig?.command || '',
      imageGenEndpoint: model.imageGeneratorConfig?.endpoint || '',
      imageGenEnv: model.imageGeneratorConfig?.env
        ? Object.entries(model.imageGeneratorConfig.env).map(([k, v]) => `${k}=${v}`).join('\n')
        : '',
      imageGenHttpFormat: model.imageGeneratorConfig?.httpFormat || 'auto',
      imageGenCliArgLines: model.imageGeneratorConfig?.cliArgLines || '',
      imageGenProvider:
        (model.imageGeneratorConfig?.provider as ImageProviderId | undefined) || '',
      imageGenApiKey: model.imageGeneratorConfig?.apiKey || '',
      imageGenModel: model.imageGeneratorConfig?.model || '',
    });
    setShowForm(true);
  }, []);

  const handleSave = useCallback(() => {
    if (formData.isChatModel !== false && (!formData.apiUrl.trim() || !formData.modelName.trim())) {
      showWarning('settings.form.required');
      return;
    }

    const envMap = parseEnvMap(formData.imageGenEnv);
    const imageGenError = validateImageGeneratorForm(formData, envMap);
    if (imageGenError) {
      showError('common.operationFailed', { detail: imageGenError });
      return;
    }

    const resolvedImageApiKey = formData.imageKeySource === 'connection' ? '' : formData.imageGenApiKey.trim();

    /** 显式厂商（非 custom）优先；否则按 Endpoint 推断后写入，便于列表展示与老逻辑兼容 */
    const resolvedImageProvider =
      formData.imageGenProvider && formData.imageGenProvider !== 'custom'
        ? formData.imageGenProvider
        : resolveImageProviderId(
            formData.imageGenProvider,
            formData.imageGenEndpoint,
            formData.imageGenHttpFormat
          );

    const payload: ModelConfig = {
      ...(editingId ? models.find(m => m.id === editingId) : {}),
      id: editingId || crypto.randomUUID(),
      name: formData.name.trim() || formData.modelName.trim() || formData.imageGenModel.trim() || 'Image tool',
      isChatModel: formData.isChatModel !== false,
      contextWindowTokens: formData.contextWindowTokens,
      provider: formData.provider,
      apiUrl: formData.apiUrl,
      apiKey: formData.apiKey,
      modelName: formData.modelName,
      chatApiMode: formData.chatApiMode,
      isLocal: formData.provider === 'ollama' || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(formData.apiUrl),
      maxTokens: formData.maxTokens,
      isImageGenerator: formData.isImageGenerator,
      imageGeneratorConfig: undefined,
      ...(formData.isImageGenerator
        ? {
            imageGeneratorConfig: {
              ...(editingId ? models.find(m => m.id === editingId)?.imageGeneratorConfig : {}),
              promptLanguage: formData.promptLanguage,
              type: formData.imageGenType as 'cli' | 'http',
              apiKeySource: formData.imageKeySource,
              quality: formData.imageQuality,
              ...(resolvedImageProvider ? { provider: resolvedImageProvider } : {}),
              apiKey: resolvedImageApiKey || undefined,
              model: formData.imageGenModel.trim() || undefined,
              command: formData.imageGenCommand,
              endpoint: formData.imageGenEndpoint,
              env: envMap,
              ...(formData.imageGenType === 'http'
                ? { httpFormat: formData.imageGenHttpFormat }
                : {}),
              ...(formData.imageGenType === 'cli' && formData.imageGenCliArgLines.trim()
                ? { cliArgLines: formData.imageGenCliArgLines }
                : {}),
            },
          }
        : {}),
    };

    if (editingId) {
      updateModel(editingId, payload);
    } else {
      addModel(payload);
    }

    setShowForm(false);
    setEditingId(null);
    setFormData(defaultFormData);
  }, [editingId, formData, models, addModel, updateModel]);

  const handleTestConnection = useCallback(async () => {
    if (!formData.apiUrl.trim() || !formData.modelName.trim()) {
      showWarning('settings.form.required');
      return;
    }
    setTestingConnection(true);
    try {
      const testModel: ModelConfig = {
        id: editingId || 'connection-test',
        name: formData.name.trim() || formData.modelName.trim(),
        provider: formData.provider,
        apiUrl: formData.apiUrl.trim(),
        apiKey: formData.apiKey.trim(),
        modelName: formData.modelName.trim(),
        chatApiMode: formData.chatApiMode,
        isLocal: false,
        maxTokens: 32,
        isChatModel: true,
      };
      await window.electron.callModel(
        [
          {
            id: `connection-test-${Date.now()}`,
            role: 'user',
            content: 'Reply with OK.',
            timestamp: Date.now(),
            model: testModel.modelName,
          },
        ],
        testModel,
        { locale: locale === 'en' ? 'en' : 'zh', connectionTest: true }
      );
      showSuccess('settings.form.connectionTestSuccess', { model: testModel.modelName });
    } catch (error) {
      showError('settings.form.connectionTestFailed', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingConnection(false);
    }
  }, [editingId, formData, locale]);

  return (
    <section className={`${cardShell} shrink-0`} aria-labelledby="settings-models-heading">
      <div className="flex items-center justify-between gap-2 border-b border-stone-300/38 px-3 py-2.5 dark:border-white/10">
        <div className="flex min-w-0 items-center gap-2">
          <FiCpu className="shrink-0 text-primary-600 dark:text-primary-400" size={16} aria-hidden />
          <h2 id="settings-models-heading" className="text-sm font-semibold text-stone-800 dark:text-white">
            {t('settings.modelConfig')}
          </h2>
        </div>
        <button
          type="button"
          aria-expanded={modelBlockExpanded}
          aria-controls="settings-models-panel"
          aria-label={modelBlockExpanded ? t('settings.aria.collapseModel') : t('settings.aria.expandModel')}
          title={modelBlockExpanded ? t('settings.action.collapse') : t('settings.action.expand')}
          onClick={() => setModelBlockExpanded((v) => !v)}
          className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-200/65 hover:text-stone-800 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {modelBlockExpanded ? <FiChevronUp size={18} /> : <FiChevronDown size={18} />}
        </button>
      </div>

      {modelBlockExpanded && (
        <div id="settings-models-panel" className="min-h-0">
          {showForm ? (
            <div className="space-y-3 px-3 pb-3 pt-3 text-stone-700 dark:text-stone-200">
              <h3 className="text-sm font-bold text-stone-800 dark:text-white">
                {editingId ? t('settings.form.editTitle') : t('settings.form.addTitle')}
              </h3>

              <label className="block space-y-1 text-xs">
                <span>{label('用途', 'Use for')}</span>
                <select aria-label={label('用途', 'Use for')} className={FORM_INPUT_LG} value={formData.isChatModel === false ? 'image' : formData.isImageGenerator ? 'both' : 'chat'} onChange={e => setFormData({ ...formData, isChatModel: e.target.value !== 'image', isImageGenerator: e.target.value !== 'chat', imageKeySource: e.target.value === 'image' ? 'independent' : formData.imageKeySource })}>
                  <option value="chat">{label('对话', 'Chat')}</option><option value="image">{label('生成图片', 'Images')}</option><option value="both">{label('对话和图片', 'Chat and images')}</option>
                </select>
              </label>
              {formData.isChatModel !== false && <div className="space-y-3">
                <label className="block space-y-1 text-xs"><span>{t('settings.form.provider')}</span>
                  <select className={FORM_INPUT_LG} value={formData.provider} onChange={e => {
                    const provider = e.target.value as ModelConfig['provider'];
                    setFormData({ ...formData, provider, chatApiMode: 'auto', apiKey: '', apiUrl: provider === 'ollama' ? 'http://127.0.0.1:11434' : provider === 'claude' ? 'https://api.anthropic.com' : provider === 'openai' ? 'https://api.openai.com/v1' : '' });
                  }}>
                    <option value="openai">OpenAI</option><option value="claude">Claude / Anthropic</option><option value="ollama">Ollama</option><option value="custom">{t('settings.provider.compatible')}</option>
                  </select>
                </label>
                <label className="block space-y-1 text-xs">
                  <span>{t('settings.form.chatApiMode')}</span>
                  <select aria-label={t('settings.form.chatApiMode')} className={FORM_INPUT_LG} value={formData.chatApiMode} onChange={e => setFormData({...formData, chatApiMode:e.target.value as EditingFormData['chatApiMode']})}>
                    <option value="auto">{t('settings.form.chatApiMode.auto')}</option>
                    <option value="anthropic">{t('settings.form.chatApiMode.anthropic')}</option>
                    <option value="openai">{t('settings.form.chatApiMode.openai')}</option>
                  </select>
                  <span className="block leading-relaxed text-stone-500 dark:text-slate-400">
                    {formData.chatApiMode === 'auto'
                      ? t('settings.form.chatApiModeDetected', { mode: resolvedChatApiMode === 'anthropic' ? 'Anthropic Messages (A)' : 'OpenAI Chat Completions (O)' })
                      : t('settings.form.chatApiModeHint')}
                  </span>
                </label>
                <label className="block space-y-1 text-xs"><span>{t('settings.form.apiUrl')}</span><input className={FORM_INPUT_LG} value={formData.apiUrl} placeholder="https://api.openai.com/v1" onChange={e => setFormData({...formData, apiUrl:e.target.value})}/></label>
                <label className="block space-y-1 text-xs"><span>{t('settings.form.apiKey')}</span><input type="password" autoComplete="off" className={FORM_INPUT_LG} value={formData.apiKey} onChange={e => setFormData({...formData, apiKey:e.target.value})}/></label>
                <label className="block space-y-1 text-xs"><span>{t('settings.form.modelName')}</span><input className={FORM_INPUT_LG} value={formData.modelName} placeholder={label('服务提供的模型名称', 'Model ID from your provider')} onChange={e => setFormData({...formData, modelName:e.target.value})}/></label>
              </div>}
              {formData.isImageGenerator && <div className="space-y-3 rounded-lg border border-stone-300/40 p-3 dark:border-white/10">
                <label className="block space-y-1 text-xs"><span>{label('图片服务', 'Image service')}</span>
                  <select className={FORM_INPUT_LG} value={formData.imageGenType === 'cli' ? 'cli' : formData.imageGenProvider} onChange={e => {
                    if (e.target.value === 'cli') { setFormData({...formData, imageGenType:'cli'}); return; }
                    const id = e.target.value as ImageProviderId;
                    const defaults = getPresetDefaults(id);
                    setFormData({...formData, imageGenType:'http', imageGenProvider:id, imageGenEndpoint:defaults.endpoint || '', imageGenModel:defaults.model || '', imageGenHttpFormat:defaults.httpFormat || 'auto', imageGenApiKey:'', imageKeySource:'independent'});
                  }}>
                    <option value="">{label('自动识别地址', 'Detect from URL')}</option>
                    {IMAGE_PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{t(p.labelKey)}</option>)}
                    <option value="cli">{label('本地脚本（CLI）', 'Local script (CLI)')}</option>
                  </select>
                </label>
                {formData.imageGenType === 'http' ? <>
                  <label className="block space-y-1 text-xs"><span>{t('settings.form.httpEndpoint')}</span><input className={FORM_INPUT_LG} value={formData.imageGenEndpoint} placeholder="https://…/images/generations" onChange={e => setFormData({...formData, imageGenEndpoint:e.target.value, imageGenProvider:'', imageGenHttpFormat:'auto'})}/></label>
                  <label className="block space-y-1 text-xs"><span>{t('settings.form.imageModel')}</span><input className={FORM_INPUT_LG} value={formData.imageGenModel} placeholder={getImageProviderPreset(resolvedImageProvider || undefined)?.defaultModel || label('模型名称', 'Model ID')} onChange={e => setFormData({...formData, imageGenModel:e.target.value})}/></label>
                  {formData.isChatModel !== false && <label className="flex gap-2 text-xs"><input type="checkbox" checked={formData.imageKeySource === 'connection'} onChange={e => setFormData({...formData, imageKeySource:e.target.checked ? 'connection' : 'independent'})}/>{label('使用上面的对话密钥', 'Use the chat API key above')}</label>}
                  {(formData.isChatModel === false || formData.imageKeySource !== 'connection') && <label className="block space-y-1 text-xs"><span>{t('settings.form.imageApiKey')}</span><input type="password" autoComplete="off" className={FORM_INPUT_LG} value={formData.imageGenApiKey} onChange={e => setFormData({...formData, imageGenApiKey:e.target.value, imageKeySource:'independent'})}/></label>}
                </> : <label className="block space-y-1 text-xs"><span>{t('settings.form.cliCommand')}</span><input className={FORM_INPUT_LG} value={formData.imageGenCommand} onChange={e => setFormData({...formData, imageGenCommand:e.target.value})}/></label>}
              </div>}
              <details className="rounded-lg border border-stone-300/40 p-3 dark:border-white/10">
                <summary className="cursor-pointer text-xs font-medium">{label('高级设置（可选）', 'Advanced settings (optional)')}</summary>
                <div className="mt-3 space-y-3">
                  <label className="block space-y-1 text-xs"><span>{label('显示名称（留空自动命名）', 'Display name (optional)')}</span><input className={FORM_INPUT_LG} value={formData.name} placeholder="My GPT-4" onChange={e => setFormData({...formData, name:e.target.value})}/></label>
                  {formData.isChatModel !== false && <>
                    <label className="block space-y-1 text-xs"><span>{label('最大输出长度（token）', 'Maximum output tokens')}</span><input type="number" min="1" className={FORM_INPUT_LG} value={formData.maxTokens} onChange={e => setFormData({...formData, maxTokens:Math.max(1, Number(e.target.value) || 4096)})}/></label>
                    <label className="block space-y-1 text-xs"><span>{label('上下文容量（token，留空自动识别）', 'Context tokens (blank: auto detect)')}</span><input type="number" min="1024" className={FORM_INPUT_LG} value={formData.contextWindowTokens ?? ''} onChange={e => setFormData({...formData, contextWindowTokens:e.target.value ? Math.max(1024, Number(e.target.value)) : undefined})}/></label>
                  </>}
                  {formData.isImageGenerator && <>
                    {formData.imageGenType === 'cli' && <label className="block space-y-1 text-xs"><span>{label('脚本提示词语言', 'Script prompt language')}</span><select className={FORM_INPUT_LG} value={formData.promptLanguage || ''} onChange={e => setFormData({...formData, promptLanguage:(e.target.value || undefined) as EditingFormData['promptLanguage']})}><option value="">{label('自动识别 SD 脚本', 'Detect SD scripts')}</option><option value="auto">{label('保留原始语言', 'Keep original language')}</option><option value="en">{label('转换为英文', 'Translate to English')}</option></select></label>}
                    {formData.imageGenType === 'http' ? <label className="block space-y-1 text-xs"><span>{t('settings.form.responseFormat')}</span><select className={FORM_INPUT_LG} value={formData.imageGenHttpFormat} onChange={e => setFormData({...formData, imageGenHttpFormat:e.target.value as EditingFormData['imageGenHttpFormat']})}>{['auto','sdwebui','ollama','openai_images','raw'].map(value => <option key={value} value={value}>{value}</option>)}</select></label> : <label className="block space-y-1 text-xs"><span>{t('settings.form.cliArgs')}</span><textarea rows={4} className={FORM_INPUT_LG} value={formData.imageGenCliArgLines} onChange={e => setFormData({...formData, imageGenCliArgLines:e.target.value})}/><span className="text-stone-500">{label('每行一个参数；留空时脚本通过 MYAGENT_PROMPT 和 MYAGENT_OUTPUT_PATH 环境变量读写。', 'One argument per line; scripts may instead use MYAGENT_PROMPT and MYAGENT_OUTPUT_PATH.')}</span></label>}
                    {resolvedImageProvider === 'openai-images' && <label className="block space-y-1 text-xs"><span>{label('画质', 'Quality')}</span><select className={FORM_INPUT_LG} value={formData.imageQuality} onChange={e => setFormData({...formData, imageQuality:e.target.value as EditingFormData['imageQuality']})}>{['auto','low','medium','high'].map(value => <option key={value}>{value}</option>)}</select></label>}
                    <label className="block space-y-1 text-xs"><span>{label('自定义环境变量 / 请求头', 'Custom environment / headers')}</span><textarea rows={4} className={FORM_INPUT_LG} value={formData.imageGenEnv} onChange={e => setFormData({...formData, imageGenEnv:e.target.value})}/></label>
                  </>}
                </div>
              </details>

              <div className="sticky bottom-0 flex gap-2 bg-stone-100 py-2 dark:bg-slate-900">
                {canTestRemoteChat && (
                  <button
                    type="button"
                    onClick={() => void handleTestConnection()}
                    disabled={testingConnection || !formData.apiUrl.trim() || !formData.modelName.trim()}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-primary-500/35 bg-primary-50 px-4 py-2 text-primary-700 transition-colors hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-55 dark:bg-primary-500/10 dark:text-primary-300 dark:hover:bg-primary-500/15"
                  >
                    {testingConnection ? <FiLoader className="animate-spin" size={14} /> : <FiWifi size={14} />}
                    <span className="text-sm font-medium">
                      {t(testingConnection ? 'settings.form.testingConnection' : 'settings.form.testConnection')}
                    </span>
                  </button>
                )}
                <button
                  onClick={handleSave}
                  className="flex-1 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <FiSave size={14} />
                  <span className="text-sm font-medium">{t('settings.form.save')}</span>
                </button>
                <button
                  onClick={() => {
                    setShowForm(false);
                    setEditingId(null);
                    setFormData(defaultFormData);
                  }}
                  className="px-4 py-2 bg-stone-200 dark:bg-slate-700 text-stone-700 dark:text-slate-200 rounded-lg transition-colors text-sm font-medium"
                >
                  {t('settings.form.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2 overflow-y-auto px-3 pb-2 pt-3 scrollbar-hide">
                {models.length === 0 ? (
                  <div className="py-5 text-center text-xs text-stone-500 dark:text-slate-500">
                    {t('settings.list.empty')}
                  </div>
                ) : (
                  models.map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center gap-2 rounded-lg border border-stone-300/38 bg-stone-50/90 px-3 py-2 dark:border-white/5 dark:bg-slate-800/90"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-stone-800 dark:text-white">
                            {model.name}
                          </span>
                          {model.isImageGenerator && (
                            <span className="rounded border border-indigo-500/20 bg-indigo-500/12 px-1.5 py-0.5 text-[9px] text-indigo-600 dark:border-indigo-500/30 dark:text-indigo-400">
                              {t('settings.badge.imageGen')}
                            </span>
                          )}
                          {model.isLocal && (
                            <span className="rounded bg-stone-400/25 px-1.5 text-[9px] text-stone-600 dark:text-slate-400">
                              {t('settings.badge.local')}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-stone-500 dark:text-slate-500">
                          {model.isChatModel === false ? model.imageGeneratorConfig?.model || model.imageGeneratorConfig?.command : model.modelName}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => startEdit(model)}
                        className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-400/20 hover:text-primary-500 dark:hover:bg-slate-700"
                        title={t('settings.list.edit')}
                      >
                        <FiEdit2 size={13} />
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          void confirmDestructive(
                            t('settings.list.confirmDelete', { name: model.name })
                          ).then((ok) => {
                            if (ok) removeModel(model.id);
                          });
                        }}
                        className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-red-50/80 hover:text-red-500 dark:hover:bg-red-500/10"
                        title={t('settings.list.delete')}
                      >
                        <FiTrash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="border-t border-stone-300/38 px-3 pb-3 pt-2.5 dark:border-white/10">
                <button
                  type="button"
                  onClick={startAdd}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  <FiPlus size={16} />
                  {t('settings.list.add')}
                </button>
              </div>
              {(() => {
                /** 生图模型独立选择：从所有勾选了「生图工具」且配置可用的模型中选一个 */
                const imageGenCandidates = models.filter((m) => modelHasUsableImageGenerator(m));
                if (imageGenCandidates.length === 0) return null;
                return (
                  <div className="border-t border-stone-300/38 px-3 pb-3 pt-2.5 dark:border-white/10">
                    <label className="mb-1 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                      {t('settings.imageGenModel')}
                    </label>
                    <select
                      value={imageGenModelId ?? ''}
                      onChange={(e) => setImageGenModel(e.target.value || null)}
                      className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                    >
                      <option value="">{t('settings.imageGenModelAuto')}</option>
                      {imageGenCandidates.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}（{m.modelName}）
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                      {t('settings.imageGenModelHint')}
                    </p>
                  </div>
                );
              })()}
              {models.length > 0 ? (
                <details className="border-t border-stone-300/38 px-3 pb-3 pt-2.5 dark:border-white/10">
                  <summary className="mb-2 cursor-pointer text-xs font-medium text-stone-600 dark:text-gray-400">
                    {t('settings.routing.title')} · {label('高级', 'Advanced')}
                  </summary>
                  <p className="mb-2 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                    {t('settings.routing.hint')}
                  </p>
                  <div className="space-y-2">
                    {effectiveRoutingRules.map((rule) => (
                      <div key={rule.id} className="space-y-1">
                        <div className="text-[10px] text-stone-600 dark:text-slate-400">
                          {rule.description}
                        </div>
                        <select
                          value={rule.preferModelId || ''}
                          onChange={(e) => updateRoutingPrefer(rule.id, e.target.value)}
                          className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                        >
                          <option value="">{t('settings.routing.none')}</option>
                          {models.filter(m => m.isChatModel !== false).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default ModelsSection;
