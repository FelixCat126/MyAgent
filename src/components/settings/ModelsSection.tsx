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
  FORM_INPUT_SM,
  FORM_INPUT_SM_MONO,
  FORM_INPUT_SM_MONO_TIGHT,
  FORM_LABEL,
  FORM_LABEL_SM,
  FORM_SELECT_SM,
} from './styleConstants';
import {
  FiCpu,
  FiChevronUp,
  FiChevronDown,
  FiChevronRight,
  FiSave,
  FiEdit2,
  FiTrash2,
  FiPlus,
} from 'react-icons/fi';
import { IosSwitch } from '../IosSwitch';
import { useModelStore, modelHasUsableImageGenerator } from '../../store/modelStore';
import { confirmDestructive } from '../../store/confirmStore';
import { showError, showWarning } from '../../store/errorStore';
import { ModelConfig } from '../../types';
import { BUILTIN_ROUTING_RULES, type RoutingRule } from '../../agent/modelRouting';
import {
  IMAGE_PROVIDER_PRESETS,
  getImageProviderPreset,
  getPresetDefaults,
  imageGenNeedsApiKey,
  inferImageProviderFromEndpoint,
  resolveImageProviderId,
  suggestedHttpFormatForProvider,
  type ImageProviderId,
} from '../../../electron/shared/imageProviderPresets';

/** 编辑表单数据结构（原 SettingsPanel.tsx 模块作用域 type，移入本组件以避免跨模块依赖） */
export type EditingFormData = {
  name: string;
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
  provider: 'openai',
  apiUrl: '',
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
    const argLines = form.imageGenCliArgLines
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (argLines.length === 0) return '启用 CLI 生图后，CLI 参数不能为空，至少需要脚本路径和输出路径占位符。';
    if (!argLines.some((line) => line.includes('{{outputPath}}'))) {
      return '启用 CLI 生图后，CLI 参数必须包含 {{outputPath}}，否则无法确认图片输出文件。';
    }
    if (!envMap.MYAGENT_SD_MODEL && !envMap.OLLAMA_MODEL && !envMap.MODEL && !envMap.MODEL_ID) {
      return '启用 CLI 生图后，环境变量必须包含模型名称，例如 MYAGENT_SD_MODEL=你的本地生图模型。';
    }
    return null;
  }
  if (form.imageGenType === 'http') {
    if (!form.imageGenEndpoint.trim()) return '启用 HTTP 生图后，接口地址不能为空。';
    if (!/^https?:\/\//i.test(form.imageGenEndpoint.trim())) {
      return '启用 HTTP 生图后，接口地址必须以 http:// 或 https:// 开头。';
    }
    if (
      form.imageGenHttpFormat === 'ollama' &&
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

  const startAdd = useCallback(() => {
    setEditingId(null);
    setFormData(defaultFormData);
    setShowForm(true);
  }, []);

  const startEdit = useCallback((model: ModelConfig) => {
    setEditingId(model.id);
    setFormData({
      name: model.name,
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
    if (!formData.name || !formData.apiUrl || !formData.modelName) {
      showWarning('settings.form.required');
      return;
    }

    const envMap = parseEnvMap(formData.imageGenEnv);
    const imageGenError = validateImageGeneratorForm(formData, envMap);
    if (imageGenError) {
      showError('common.operationFailed', { detail: imageGenError });
      return;
    }

    const existingImageKey =
      editingId != null
        ? models.find((m) => m.id === editingId)?.imageGeneratorConfig?.apiKey?.trim()
        : undefined;
    /** 生图密钥：优先表单字段；空则保留已存密钥；再回退同一模型顶部「API 密钥」 */
    const resolvedImageApiKey =
      formData.imageGenApiKey.trim() || existingImageKey || formData.apiKey.trim() || '';

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
      id: editingId || Date.now().toString(),
      name: formData.name,
      provider: formData.provider,
      apiUrl: formData.apiUrl,
      apiKey: formData.apiKey,
      modelName: formData.modelName,
      chatApiMode: formData.chatApiMode,
      isLocal: formData.isLocal,
      maxTokens: formData.maxTokens,
      isImageGenerator: formData.isImageGenerator,
      imageGeneratorConfig: undefined,
      ...(formData.isImageGenerator
        ? {
            imageGeneratorConfig: {
              type: formData.imageGenType as 'cli' | 'http',
              ...(resolvedImageProvider ? { provider: resolvedImageProvider } : {}),
              ...(resolvedImageApiKey ? { apiKey: resolvedImageApiKey } : {}),
              ...(formData.imageGenModel.trim() ? { model: formData.imageGenModel.trim() } : {}),
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
            <div className="max-h-[min(52vh,28rem)] space-y-4 overflow-y-auto px-3 pb-3 pt-3 scrollbar-hide">
              <h3 className="text-sm font-bold text-stone-800 dark:text-white">
                {editingId ? t('settings.form.editTitle') : t('settings.form.addTitle')}
              </h3>

              <div>
                <label className={FORM_LABEL}>
                  {t('settings.form.name')}
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('settings.form.namePh')}
                  className={FORM_INPUT_LG}
                />
              </div>

              <div>
                <label className={FORM_LABEL}>
                  {t('settings.form.provider')}
                </label>
                <select
                  value={formData.provider}
                  onChange={(e) => setFormData({ ...formData, provider: e.target.value as ModelConfig['provider'] })}
                  className={FORM_INPUT_LG}
                >
                  <option value="openai">OpenAI</option>
                  <option value="claude">Claude</option>
                  <option value="ollama">Ollama</option>
                  <option value="custom">{t('settings.provider.custom')}</option>
                </select>
              </div>

              {(formData.provider === 'openai' ||
                formData.provider === 'custom' ||
                formData.provider === 'ollama') && (
                <div>
                  <label className={FORM_LABEL}>
                    {t('settings.form.chatApiMode')}
                  </label>
                  <select
                    value={formData.chatApiMode}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        chatApiMode: e.target.value as EditingFormData['chatApiMode'],
                      })
                    }
                    className={FORM_INPUT_LG}
                  >
                    <option value="auto">{t('settings.form.chatApiMode.auto')}</option>
                    <option value="openai">{t('settings.form.chatApiMode.openai')}</option>
                    <option value="anthropic">{t('settings.form.chatApiMode.anthropic')}</option>
                  </select>
                  <p className="mt-1 text-[11px] text-stone-500 dark:text-gray-400 leading-snug">
                    {t('settings.form.chatApiModeHint')}
                  </p>
                </div>
              )}

              <div>
                <label className={FORM_LABEL}>
                  {t('settings.form.apiUrl')}
                </label>
                <input
                  type="text"
                  value={formData.apiUrl}
                  onChange={(e) => setFormData({ ...formData, apiUrl: e.target.value })}
                  placeholder={
                    formData.provider === 'ollama' ? t('settings.form.apiUrlPh.ollama') : t('settings.form.apiUrlPh.default')
                  }
                  className={FORM_INPUT_LG}
                />
              </div>

              <div>
                <label className={FORM_LABEL}>
                  {t('settings.form.apiKey')}
                  {formData.provider !== 'ollama' && ' *'}
                </label>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder={t('settings.form.apiKeyPh')}
                  className={FORM_INPUT_LG}
                />
              </div>

              <div>
                <label className={FORM_LABEL}>
                  {t('settings.form.modelName')}
                </label>
                <input
                  type="text"
                  value={formData.modelName}
                  onChange={(e) => setFormData({ ...formData, modelName: e.target.value })}
                  placeholder={
                    formData.provider === 'openai' ? t('settings.form.modelNamePh.openai') : t('settings.form.modelNamePh.other')
                  }
                  className={FORM_INPUT_LG}
                />
              </div>

              <div>
                <label className={FORM_LABEL}>
                  {t('settings.form.maxTokens')}
                </label>
                <input
                  type="number"
                  value={formData.maxTokens}
                  onChange={(e) => {
                    /** 空值/非法输入回落 0（下游按 falsy 走默认 4096），避免 NaN 写入持久化 JSON 变 null */
                    const n = Math.floor(Number(e.target.value));
                    setFormData({ ...formData, maxTokens: Number.isFinite(n) && n > 0 ? n : 0 });
                  }}
                  className={FORM_INPUT_LG}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-stone-700 dark:text-gray-300">{t('settings.form.localModel')}</span>
                <IosSwitch
                  checked={formData.isLocal}
                  aria-label={t('settings.form.localModel')}
                  onChange={(next) => setFormData({ ...formData, isLocal: next })}
                />
              </div>

              <div className="border-t border-stone-400/22 dark:border-gray-700 pt-4">
                <h4 className="mb-2 text-xs font-semibold text-stone-700 dark:text-gray-300">{t('settings.form.imageGenSection')}</h4>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-stone-700 dark:text-gray-300">{t('settings.form.useAsImageTool')}</span>
                    <IosSwitch
                      checked={formData.isImageGenerator}
                      aria-label={t('settings.form.useAsImageTool')}
                      onChange={(next) => setFormData({ ...formData, isImageGenerator: next })}
                    />
                  </div>

                  {formData.isImageGenerator ? (
                    <>
                      {/* ===== 工具类型：HTTP 优先 ===== */}
                      <div>
                        <label className={FORM_LABEL_SM}>
                          {t('settings.form.toolType')}
                        </label>
                        <select
                          value={formData.imageGenType}
                          onChange={(e) => setFormData({ ...formData, imageGenType: e.target.value })}
                          className={FORM_SELECT_SM}
                        >
                          <option value="http">{t('settings.form.httpServer')}</option>
                          <option value="cli">{t('settings.form.cliTool')}</option>
                        </select>
                      </div>

                      {formData.imageGenType === 'http' ? (
                        <>
                          {/* ===== Endpoint 优先：粘贴地址即可自适配 ===== */}
                          <div>
                            <label className={FORM_LABEL_SM}>
                              {t('settings.form.httpEndpoint')}
                            </label>
                            <input
                              type="text"
                              value={formData.imageGenEndpoint}
                              onChange={(e) => {
                                const endpoint = e.target.value;
                                const inferred = inferImageProviderFromEndpoint(
                                  endpoint,
                                  formData.imageGenHttpFormat
                                );
                                const suggestedFmt = suggestedHttpFormatForProvider(inferred);
                                setFormData({
                                  ...formData,
                                  imageGenEndpoint: endpoint,
                                  /** 仅在仍为 auto 时跟推断结果回填格式，不覆盖用户手动选择 */
                                  ...(formData.imageGenHttpFormat === 'auto' && suggestedFmt && suggestedFmt !== 'auto'
                                    ? { imageGenHttpFormat: suggestedFmt }
                                    : {}),
                                  /** 模型名为空时用预设默认模型 */
                                  ...(inferred && !formData.imageGenModel.trim()
                                    ? {
                                        imageGenModel:
                                          getImageProviderPreset(inferred)?.defaultModel ||
                                          formData.imageGenModel,
                                      }
                                    : {}),
                                });
                              }}
                              placeholder={t('settings.form.httpEndpointPh')}
                              className={FORM_SELECT_SM}
                            />
                            {(() => {
                              const inferred = resolvedImageProvider;
                              if (!inferred || !formData.imageGenEndpoint.trim()) return null;
                              const preset = getImageProviderPreset(inferred);
                              return (
                                <p className="mt-1 text-[10px] text-emerald-700/90 dark:text-emerald-400/90">
                                  {t('settings.form.imageProviderInferred', {
                                    name: preset ? t(preset.labelKey) : inferred,
                                  })}
                                </p>
                              );
                            })()}
                          </div>

                          {/* ===== API Key / 模型名：云端或未识别时显示 ===== */}
                          {imageGenNeedsApiKey(
                            formData.imageGenProvider,
                            formData.imageGenEndpoint,
                            formData.imageGenHttpFormat
                          ) ? (
                            <div className="space-y-2">
                              <div>
                                <label className={FORM_LABEL_SM}>
                                  {t('settings.form.imageApiKey')}
                                </label>
                                <input
                                  type="password"
                                  autoComplete="off"
                                  value={formData.imageGenApiKey}
                                  onChange={(e) =>
                                    setFormData({ ...formData, imageGenApiKey: e.target.value })
                                  }
                                  placeholder={(() => {
                                    const id = resolvedImageProvider;
                                    const ph = id
                                      ? getImageProviderPreset(id)?.apiKeyPlaceholderKey
                                      : undefined;
                                    return ph ? t(ph) : 'sk-…';
                                  })()}
                                  className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                                />
                              </div>
                              <div>
                                <label className={FORM_LABEL_SM}>
                                  {t('settings.form.imageModel')}
                                </label>
                                <input
                                  type="text"
                                  value={formData.imageGenModel}
                                  onChange={(e) =>
                                    setFormData({ ...formData, imageGenModel: e.target.value })
                                  }
                                  placeholder={(() => {
                                    const id = resolvedImageProvider;
                                    return (
                                      (id && getImageProviderPreset(id)?.defaultModel) ||
                                      t('settings.form.imageModelPh')
                                    );
                                  })()}
                                  className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                                />
                              </div>
                            </div>
                          ) : (
                            <div>
                              <label className={FORM_LABEL_SM}>
                                {t('settings.form.imageModel')}
                              </label>
                              <input
                                type="text"
                                value={formData.imageGenModel}
                                onChange={(e) =>
                                  setFormData({ ...formData, imageGenModel: e.target.value })
                                }
                                placeholder={
                                  getImageProviderPreset(
                                    resolvedImageProvider || undefined
                                  )?.defaultModel || t('settings.form.imageModelPh')
                                }
                                className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                              />
                            </div>
                          )}

                          {/* ===== 可选：快捷预设（仅回填，非必选） ===== */}
                          <div>
                            <label className={FORM_LABEL_SM}>
                              {t('settings.form.imageProviderOptional')}
                            </label>
                            <select
                              value={formData.imageGenProvider || ''}
                              onChange={(e) => {
                                const id = e.target.value as ImageProviderId | '';
                                const defaults = getPresetDefaults(id || undefined);
                                const switching = id !== formData.imageGenProvider;
                                setFormData({
                                  ...formData,
                                  imageGenProvider: id,
                                  imageGenType:
                                    id === 'custom'
                                      ? formData.imageGenType
                                      : defaults.type ?? formData.imageGenType,
                                  imageGenEndpoint:
                                    id === 'custom'
                                      ? formData.imageGenEndpoint
                                      : defaults.endpoint ?? formData.imageGenEndpoint,
                                  imageGenHttpFormat:
                                    id === 'custom'
                                      ? formData.imageGenHttpFormat
                                      : defaults.httpFormat ?? formData.imageGenHttpFormat,
                                  imageGenApiKey:
                                    // 切换厂商时清空密钥：旧厂商的 Key 不应被带往新厂商站点
                                    switching ? '' : formData.imageGenApiKey,
                                  imageGenModel: switching
                                    ? defaults.model ?? formData.imageGenModel
                                    : formData.imageGenModel,
                                });
                              }}
                              className={FORM_SELECT_SM}
                            >
                              <option value="">{t('settings.form.imageProviderPh')}</option>
                              {IMAGE_PROVIDER_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {t(p.labelKey)}
                                </option>
                              ))}
                            </select>
                            <p className="mt-1 text-[10px] text-stone-500 dark:text-slate-500">
                              {t('settings.form.imageProviderHint')}
                            </p>
                          </div>
                        </>
                      ) : null}

                      {formData.imageGenType === 'cli' ? (
                        <div className="space-y-2">
                          <div>
                            <label className={FORM_LABEL_SM}>
                              {t('settings.form.cliCommand')}
                            </label>
                            <input
                              type="text"
                              value={formData.imageGenCommand}
                              onChange={(e) =>
                                setFormData({ ...formData, imageGenCommand: e.target.value })
                              }
                              placeholder={t('settings.form.cliCommandPh')}
                              className={FORM_SELECT_SM}
                            />
                          </div>
                          <div>
                            <label className={FORM_LABEL_SM}>
                              {t('settings.form.cliArgs')}
                            </label>
                            <textarea
                              value={formData.imageGenCliArgLines}
                              onChange={(e) =>
                                setFormData({ ...formData, imageGenCliArgLines: e.target.value })
                              }
                              placeholder={t('settings.form.cliArgsPh')}
                              rows={5}
                              className={FORM_INPUT_SM_MONO}
                            />
                          </div>
                        </div>
                      ) : null}

                      {/* ===== 高级：响应格式 / env（CLI 参数已在上方） ===== */}
                      <details className="group/details rounded-lg border border-stone-300/38 bg-stone-100/70 px-2 py-1.5 dark:border-white/10 dark:bg-slate-900/55">
                        <summary className="flex cursor-pointer items-center gap-1 select-none text-[10px] font-medium text-stone-600 dark:text-slate-400 list-none [&::-webkit-details-marker]:hidden">
                          <FiChevronRight
                            size={12}
                            className="shrink-0 text-stone-400 transition-transform duration-200 group-open/details:rotate-90 dark:text-slate-500"
                            aria-hidden
                          />
                          {t('settings.form.imageGenAdvanced')}
                        </summary>
                        <div className="mt-2 space-y-3 border-t border-stone-300/35 pt-2 dark:border-white/8">
                          {formData.imageGenType === 'http' ? (
                            <div>
                              <label className={FORM_LABEL_SM}>
                                {t('settings.form.responseFormat')}
                              </label>
                              <select
                                value={formData.imageGenHttpFormat}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    imageGenHttpFormat: e.target
                                      .value as EditingFormData['imageGenHttpFormat'],
                                  })
                                }
                                className={FORM_INPUT_SM}
                              >
                                <option value="auto">{t('settings.form.format.auto')}</option>
                                <option value="sdwebui">{t('settings.form.format.sdwebui')}</option>
                                <option value="ollama">{t('settings.form.format.ollama')}</option>
                                <option value="openai_images">
                                  {t('settings.form.format.openaiImages')}
                                </option>
                                <option value="raw">{t('settings.form.format.raw')}</option>
                              </select>
                            </div>
                          ) : null}
                          <div>
                            <label className={FORM_LABEL_SM}>
                              {t('settings.form.envVars')}
                            </label>
                            <textarea
                              value={formData.imageGenEnv}
                              onChange={(e) => setFormData({ ...formData, imageGenEnv: e.target.value })}
                              placeholder={t('settings.form.envPh')}
                              className={FORM_INPUT_SM_MONO_TIGHT}
                              rows={2}
                            />
                            <p className="mt-1 text-[10px] text-stone-500 dark:text-slate-500">
                              {t('settings.form.imageGenHttpExtraHint')}
                            </p>
                          </div>
                        </div>
                      </details>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
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
                          {model.modelName}
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
                <div className="border-t border-stone-300/38 px-3 pb-3 pt-2.5 dark:border-white/10">
                  <label className="mb-1 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                    {t('settings.routing.title')}
                  </label>
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
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default ModelsSection;
