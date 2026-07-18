/**
 * 模型配置区：模型列表（增删改）+ 编辑表单（基础信息 + 生图工具高级配置）+ 生图模型独立选择。
 *
 * 抽离自 SettingsPanel.tsx（aria-labelledby="settings-models-heading" 的 <section>），
 * 行为与拆分前完全一致。
 *
 * 状态拆分原则：
 *  - store 派生量（models / imageGenModelId 等）→ 本组件自己调 useModelStore
 *  - 父组件局部 useState（showForm / editingId / formData）与 useCallback（startAdd / startEdit / handleSave）→ 通过 props 传入
 *    （这些 handler 依赖父组件的 formData/setEditingId/setShowForm 等 setter，整体留在父组件更合理，
 *      子组件只负责渲染与调用）
 */

import React from 'react';
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
import { ModelConfig } from '../../types';
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

export interface ModelsSectionProps {
  /** 折叠态（父组件 useState） */
  modelBlockExpanded: boolean;
  setModelBlockExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  /** 是否显示编辑表单（父组件 useState：value + setter） */
  showForm: boolean;
  setShowForm: React.Dispatch<React.SetStateAction<boolean>>;
  /** 当前正在编辑的模型 id（null=新增）（父组件 useState：value + setter） */
  editingId: string | null;
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  /** 表单数据（父组件 useState：value + setter） */
  formData: EditingFormData;
  setFormData: React.Dispatch<React.SetStateAction<EditingFormData>>;
  /** 新增模型（父组件 useCallback） */
  startAdd: () => void;
  /** 编辑某个模型（父组件 useCallback） */
  startEdit: (model: ModelConfig) => void;
  /** 保存表单（父组件 useCallback） */
  handleSave: () => void;
  /** 卡片外壳 CSS（父组件常量） */
  cardShell: string;
  /** i18n 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const ModelsSection: React.FC<ModelsSectionProps> = ({
  modelBlockExpanded,
  setModelBlockExpanded,
  showForm,
  setShowForm,
  editingId,
  setEditingId,
  formData,
  setFormData,
  startAdd,
  startEdit,
  handleSave,
  cardShell,
  t,
}) => {
  // store 派生量本组件自己消费
  const { models, removeModel, imageGenModelId, setImageGenModel } = useModelStore();

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
                <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
                  {t('settings.form.name')}
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('settings.form.namePh')}
                  className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
                  {t('settings.form.provider')}
                </label>
                <select
                  value={formData.provider}
                  onChange={(e) => setFormData({ ...formData, provider: e.target.value as ModelConfig['provider'] })}
                  className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
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
                  <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
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
                    className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
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
                <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
                  {t('settings.form.apiUrl')}
                </label>
                <input
                  type="text"
                  value={formData.apiUrl}
                  onChange={(e) => setFormData({ ...formData, apiUrl: e.target.value })}
                  placeholder={
                    formData.provider === 'ollama' ? t('settings.form.apiUrlPh.ollama') : t('settings.form.apiUrlPh.default')
                  }
                  className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
                  {t('settings.form.apiKey')}
                  {formData.provider !== 'ollama' && ' *'}
                </label>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder={t('settings.form.apiKeyPh')}
                  className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
                  {t('settings.form.modelName')}
                </label>
                <input
                  type="text"
                  value={formData.modelName}
                  onChange={(e) => setFormData({ ...formData, modelName: e.target.value })}
                  placeholder={
                    formData.provider === 'openai' ? t('settings.form.modelNamePh.openai') : t('settings.form.modelNamePh.other')
                  }
                  className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1">
                  {t('settings.form.maxTokens')}
                </label>
                <input
                  type="number"
                  value={formData.maxTokens}
                  onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
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
                        <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                          {t('settings.form.toolType')}
                        </label>
                        <select
                          value={formData.imageGenType}
                          onChange={(e) => setFormData({ ...formData, imageGenType: e.target.value })}
                          className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                        >
                          <option value="http">{t('settings.form.httpServer')}</option>
                          <option value="cli">{t('settings.form.cliTool')}</option>
                        </select>
                      </div>

                      {formData.imageGenType === 'http' ? (
                        <>
                          {/* ===== Endpoint 优先：粘贴地址即可自适配 ===== */}
                          <div>
                            <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
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
                              className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                            />
                            {(() => {
                              const inferred = resolveImageProviderId(
                                formData.imageGenProvider,
                                formData.imageGenEndpoint,
                                formData.imageGenHttpFormat
                              );
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
                                <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
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
                                    const id = resolveImageProviderId(
                                      formData.imageGenProvider,
                                      formData.imageGenEndpoint,
                                      formData.imageGenHttpFormat
                                    );
                                    const ph = id
                                      ? getImageProviderPreset(id)?.apiKeyPlaceholderKey
                                      : undefined;
                                    return ph ? t(ph) : 'sk-…';
                                  })()}
                                  className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                                  {t('settings.form.imageModel')}
                                </label>
                                <input
                                  type="text"
                                  value={formData.imageGenModel}
                                  onChange={(e) =>
                                    setFormData({ ...formData, imageGenModel: e.target.value })
                                  }
                                  placeholder={(() => {
                                    const id = resolveImageProviderId(
                                      formData.imageGenProvider,
                                      formData.imageGenEndpoint,
                                      formData.imageGenHttpFormat
                                    );
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
                              <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
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
                                    resolveImageProviderId(
                                      formData.imageGenProvider,
                                      formData.imageGenEndpoint,
                                      formData.imageGenHttpFormat
                                    ) || undefined
                                  )?.defaultModel || t('settings.form.imageModelPh')
                                }
                                className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                              />
                            </div>
                          )}

                          {/* ===== 可选：快捷预设（仅回填，非必选） ===== */}
                          <div>
                            <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
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
                                    id && switching ? formData.imageGenApiKey : formData.imageGenApiKey,
                                  imageGenModel: switching
                                    ? defaults.model ?? formData.imageGenModel
                                    : formData.imageGenModel,
                                });
                              }}
                              className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
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
                            <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                              {t('settings.form.cliCommand')}
                            </label>
                            <input
                              type="text"
                              value={formData.imageGenCommand}
                              onChange={(e) =>
                                setFormData({ ...formData, imageGenCommand: e.target.value })
                              }
                              placeholder={t('settings.form.cliCommandPh')}
                              className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                              {t('settings.form.cliArgs')}
                            </label>
                            <textarea
                              value={formData.imageGenCliArgLines}
                              onChange={(e) =>
                                setFormData({ ...formData, imageGenCliArgLines: e.target.value })
                              }
                              placeholder={t('settings.form.cliArgsPh')}
                              rows={5}
                              className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-[10px] font-mono leading-snug bg-stone-50/90 dark:bg-slate-800 text-stone-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500"
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
                              <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
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
                                className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                              >
                                <option value="auto">{t('settings.form.format.auto')}</option>
                                <option value="sdwebui">{t('settings.form.format.sdwebui')}</option>
                                <option value="ollama">{t('settings.form.format.ollama')}</option>
                                <option value="openai_images">
                                  {t('settings.form.format.openai_images')}
                                </option>
                                <option value="raw">{t('settings.form.format.raw')}</option>
                              </select>
                            </div>
                          ) : null}
                          <div>
                            <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                              {t('settings.form.envVars')}
                            </label>
                            <textarea
                              value={formData.imageGenEnv}
                              onChange={(e) => setFormData({ ...formData, imageGenEnv: e.target.value })}
                              placeholder={t('settings.form.envPh')}
                              className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-[10px] font-mono leading-tight bg-stone-50/90 dark:bg-slate-800 text-stone-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500"
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
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default ModelsSection;
