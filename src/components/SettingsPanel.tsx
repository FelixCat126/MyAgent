import React, { useState, useEffect, useCallback } from 'react';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { ModelConfig, WebSearchProvider } from '../types';
import {
  FiPlus,
  FiTrash2,
  FiSave,
  FiEdit2,
  FiChevronDown,
  FiChevronUp,
  FiGlobe,
  FiCpu,
  FiZap,
  FiFolder,
  FiShield,
  FiLayers,
} from 'react-icons/fi';
import { IosSwitch } from './IosSwitch';
import { useI18n } from '../hooks/useI18n';

type EditingFormData = {
  name: string;
  provider: ModelConfig['provider'];
  apiUrl: string;
  apiKey: string;
  modelName: string;
  isLocal: boolean;
  maxTokens: number;
  isImageGenerator: boolean;
  imageGenType: string;
  imageGenCommand: string;
  imageGenEndpoint: string;
  imageGenEnv: string;
  imageGenHttpFormat: 'auto' | 'sdwebui' | 'ollama' | 'raw';
  imageGenCliArgLines: string;
};

const defaultFormData: EditingFormData = {
  name: '',
  provider: 'openai',
  apiUrl: '',
  apiKey: '',
  modelName: '',
  isLocal: false,
  maxTokens: 4096,
  isImageGenerator: false,
  imageGenType: 'cli',
  imageGenCommand: '',
  imageGenEndpoint: '',
  imageGenEnv: '',
  imageGenHttpFormat: 'auto',
  imageGenCliArgLines: '',
};

const SettingsPanel: React.FC = () => {
  const { t } = useI18n();
  const { models, addModel, removeModel, updateModel } = useModelStore();
  const {
    enabled: webSearchEnabled,
    provider: webSearchProvider,
    apiKey: webSearchApiKey,
    setEnabled: setWebSearchEnabled,
    setProvider: setWebSearchProvider,
    setApiKey: setWebSearchApiKey,
  } = useWebSearchStore();
  const { streamResponses, setStreamResponses } = useSettingStore();
  const { rootPath, maxChars, setRootPath, setMaxChars } = useWorkspaceStore();
  const {
    vectorRagEnabled,
    setVectorRagEnabled,
    vectorTopK,
    setVectorTopK,
    ragMaxInjectChars,
    setRagMaxInjectChars,
    embeddingProvider,
    setEmbeddingProvider,
    embeddingApiUrl,
    setEmbeddingApiUrl,
    embeddingApiKey,
    setEmbeddingApiKey,
    embeddingModel,
    setEmbeddingModel,
    embeddingVolcMultimodal,
    setEmbeddingVolcMultimodal,
    getEmbedConfigForIpc,
  } = useKnowledgeStore();
  const [modelBlockExpanded, setModelBlockExpanded] = useState(true);
  const [webSearchBlockExpanded, setWebSearchBlockExpanded] = useState(true);
  const [knowledgeBlockExpanded, setKnowledgeBlockExpanded] = useState(true);
  const [appBlockExpanded, setAppBlockExpanded] = useState(true);
  const [indexBusy, setIndexBusy] = useState(false);
  const [incrementalIndexBusy, setIncrementalIndexBusy] = useState(false);
  const knowledgeIndexLocked = indexBusy || incrementalIndexBusy;
  const [indexMeta, setIndexMeta] = useState<{
    chunkCount: number;
    root: string | null;
    model: string | null;
    updatedAt: number;
  } | null>(null);

  const refreshIndexStatus = useCallback(async () => {
    try {
      const s = await window.electron.knowledgeGetIndexStatus();
      if (s?.ok) {
        setIndexMeta({
          chunkCount: s.chunkCount,
          root: s.root,
          model: s.model,
          updatedAt: s.updatedAt,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshIndexStatus();
  }, [refreshIndexStatus]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<EditingFormData>(defaultFormData);

  const startAdd = () => {
    setEditingId(null);
    setFormData(defaultFormData);
    setShowForm(true);
  };

  const startEdit = (model: ModelConfig) => {
    setEditingId(model.id);
    setFormData({
      name: model.name,
      provider: model.provider,
      apiUrl: model.apiUrl,
      apiKey: model.apiKey || '',
      modelName: model.modelName,
      isLocal: model.isLocal,
      maxTokens: model.maxTokens,
      isImageGenerator: model.isImageGenerator || false,
      imageGenType: model.imageGeneratorConfig?.type || 'cli',
      imageGenCommand: model.imageGeneratorConfig?.command || '',
      imageGenEndpoint: model.imageGeneratorConfig?.endpoint || '',
      imageGenEnv: model.imageGeneratorConfig?.env
        ? Object.entries(model.imageGeneratorConfig.env).map(([k, v]) => `${k}=${v}`).join('\n')
        : '',
      imageGenHttpFormat: model.imageGeneratorConfig?.httpFormat || 'auto',
      imageGenCliArgLines: model.imageGeneratorConfig?.cliArgLines || '',
    });
    setShowForm(true);
  };

  const handleSave = () => {
    if (!formData.name || !formData.apiUrl || !formData.modelName) {
      alert(t('settings.form.required'));
      return;
    }

    const envMap: Record<string, string> = {};
    const envLines = formData.imageGenEnv.trim().split('\n');
    for (const line of envLines) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        envMap[k] = v;
      }
    }

    const payload: ModelConfig = {
      id: editingId || Date.now().toString(),
      name: formData.name,
      provider: formData.provider,
      apiUrl: formData.apiUrl,
      apiKey: formData.apiKey,
      modelName: formData.modelName,
      isLocal: formData.isLocal,
      maxTokens: formData.maxTokens,
      ...(formData.isImageGenerator
        ? {
            isImageGenerator: true,
            imageGeneratorConfig: {
              type: formData.imageGenType as 'cli' | 'http',
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
  };

  const cardShell =
    'mx-3 rounded-xl border border-stone-300/45 bg-white/88 shadow-sm dark:border-white/10 dark:bg-slate-900/55 dark:shadow-none';

  return (
    <div className="flex h-full flex-col bg-stone-100/95 backdrop-blur-xl dark:bg-[#0B1120]/80">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2.5 scrollbar-hide">
        {/* 模型配置：独立卡片 */}
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
              onChange={(e) => setFormData({ ...formData, provider: e.target.value as any })}
              className="w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white"
            >
              <option value="openai">OpenAI</option>
              <option value="claude">Claude</option>
              <option value="ollama">Ollama</option>
              <option value="custom">{t('settings.provider.custom')}</option>
            </select>
          </div>

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

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isLocal"
              checked={formData.isLocal}
              onChange={(e) => setFormData({ ...formData, isLocal: e.target.checked })}
              className="rounded"
            />
            <label htmlFor="isLocal" className="text-xs text-stone-700 dark:text-gray-300">
              {t('settings.form.localModel')}
            </label>
          </div>

          <div className="border-t border-stone-400/22 dark:border-gray-700 pt-4">
            <h4 className="text-xs font-semibold text-stone-700 dark:text-gray-300">{t('settings.form.imageGenSection')}</h4>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isImageGenerator"
                  checked={formData.isImageGenerator}
                  onChange={(e) => setFormData({ ...formData, isImageGenerator: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="isImageGenerator" className="text-xs text-stone-700 dark:text-gray-300">
                  {t('settings.form.useAsImageTool')}
                </label>
              </div>

              {formData.isImageGenerator ? (
                <>
                  <div>
                    <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                      {t('settings.form.toolType')}
                    </label>
                    <select
                      value={formData.imageGenType}
                      onChange={(e) => setFormData({ ...formData, imageGenType: e.target.value })}
                      className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                    >
                      <option value="cli">{t('settings.form.cliTool')}</option>
                      <option value="http">{t('settings.form.httpServer')}</option>
                    </select>
                  </div>

                  {formData.imageGenType === 'cli' ? (
                    <div>
                      <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                        {t('settings.form.cliCommand')}
                      </label>
                      <input
                        type="text"
                        value={formData.imageGenCommand}
                        onChange={(e) => setFormData({ ...formData, imageGenCommand: e.target.value })}
                        placeholder={t('settings.form.cliCommandPh')}
                        className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                      />
                      <div className="mt-2">
                        <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                          {t('settings.form.cliArgs')}
                        </label>
                        <textarea
                          value={formData.imageGenCliArgLines}
                          onChange={(e) => setFormData({ ...formData, imageGenCliArgLines: e.target.value })}
                          placeholder={t('settings.form.cliArgsPh')}
                          rows={5}
                          className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-[10px] font-mono leading-snug bg-stone-50/90 dark:bg-slate-800 text-stone-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                        />
                      </div>
                    </div>
                  ) : formData.imageGenType === 'http' ? (
                    <>
                      <div>
                        <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                          {t('settings.form.httpEndpoint')}
                        </label>
                        <input
                          type="text"
                          value={formData.imageGenEndpoint}
                          onChange={(e) => setFormData({ ...formData, imageGenEndpoint: e.target.value })}
                          placeholder={t('settings.form.httpEndpointPh')}
                          className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1">
                          {t('settings.form.responseFormat')}
                        </label>
                        <select
                          value={formData.imageGenHttpFormat}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              imageGenHttpFormat: e.target.value as EditingFormData['imageGenHttpFormat'],
                            })
                          }
                          className="w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white"
                        >
                          <option value="auto">{t('settings.form.format.auto')}</option>
                          <option value="sdwebui">{t('settings.form.format.sdwebui')}</option>
                          <option value="ollama">{t('settings.form.format.ollama')}</option>
                          <option value="raw">{t('settings.form.format.raw')}</option>
                        </select>
                        <p className="mt-1 text-[10px] text-stone-500 dark:text-slate-500">
                          {t('settings.form.ollamaEnvHint')}{' '}
                          <code className="text-[9px]">OLLAMA_MODEL=…</code>
                        </p>
                      </div>
                    </>
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
                  </div>
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
                              if (confirm(t('settings.list.confirmDelete', { name: model.name }))) {
                                removeModel(model.id);
                              }
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
                </>
              )}
            </div>
          )}
        </section>

        {/* 联网搜索：独立卡片 */}
        <section
          className={`${cardShell} mt-2 shrink-0`}
          aria-labelledby="settings-websearch-heading"
        >
          <div className="flex items-center justify-between gap-2 border-b border-stone-300/38 px-3 py-2.5 dark:border-white/10">
            <div className="flex min-w-0 items-center gap-2">
              <FiGlobe className="shrink-0 text-primary-600 dark:text-primary-400" size={16} aria-hidden />
              <h2 id="settings-websearch-heading" className="text-sm font-semibold text-stone-800 dark:text-white">
                {t('settings.web')}
              </h2>
            </div>
            <button
              type="button"
              aria-expanded={webSearchBlockExpanded}
              aria-controls="settings-websearch-panel"
              aria-label={webSearchBlockExpanded ? t('settings.aria.collapseWeb') : t('settings.aria.expandWeb')}
              title={webSearchBlockExpanded ? t('settings.action.collapse') : t('settings.action.expand')}
              onClick={() => setWebSearchBlockExpanded((v) => !v)}
              className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-200/65 hover:text-stone-800 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {webSearchBlockExpanded ? <FiChevronUp size={18} /> : <FiChevronDown size={18} />}
            </button>
          </div>

          {webSearchBlockExpanded && (
            <div id="settings-websearch-panel" className="space-y-2 px-3 pb-3 pt-3">
              <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">{t('settings.webDesc')}</p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-stone-700 dark:text-slate-300">{t('settings.webEnable')}</span>
                <IosSwitch
                  checked={webSearchEnabled}
                  aria-label={t('settings.webEnable')}
                  onChange={setWebSearchEnabled}
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                  {t('settings.provider')}
                </label>
                <select
                  value={webSearchProvider}
                  onChange={(e) => setWebSearchProvider(e.target.value as WebSearchProvider)}
                  className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                >
                  <option value="duckduckgo">{t('settings.duck.option')}</option>
                  <option value="tavily">Tavily</option>
                  <option value="brave">Brave Search</option>
                </select>
              </div>
              {(webSearchProvider === 'tavily' || webSearchProvider === 'brave') && (
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                    {t('settings.apiKey')}
                  </label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={webSearchApiKey}
                    onChange={(e) => setWebSearchApiKey(e.target.value)}
                    placeholder={webSearchProvider === 'tavily' ? 'tvly-...' : 'BSA...'}
                    className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                  />
                </div>
              )}
            </div>
          )}
        </section>

        <section
          className={`${cardShell} mt-2 shrink-0`}
          aria-labelledby="settings-knowledge-heading"
        >
          <div className="flex items-center justify-between gap-2 border-b border-stone-300/38 px-3 py-2.5 dark:border-white/10">
            <div className="flex min-w-0 items-center gap-2">
              <FiLayers className="shrink-0 text-primary-600 dark:text-primary-400" size={16} aria-hidden />
              <h2 id="settings-knowledge-heading" className="text-sm font-semibold text-stone-800 dark:text-white">
                {t('settings.knowledge')}
              </h2>
            </div>
            <button
              type="button"
              aria-expanded={knowledgeBlockExpanded}
              onClick={() => setKnowledgeBlockExpanded((v) => !v)}
              className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-200/65 hover:text-stone-800 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {knowledgeBlockExpanded ? <FiChevronUp size={18} /> : <FiChevronDown size={18} />}
            </button>
          </div>
          {knowledgeBlockExpanded && (
            <div className="space-y-2.5 px-3 pb-3 pt-3">
              <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                {t('settings.knowledgeDescShort')}
              </p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-stone-700 dark:text-slate-300">{t('settings.ragEnableShort')}</span>
                <IosSwitch
                  checked={vectorRagEnabled}
                  aria-label={t('settings.ragEnableShort')}
                  onChange={setVectorRagEnabled}
                />
              </div>
              <p className="text-[10px] font-medium text-stone-600 dark:text-slate-400">
                {t('settings.knowledgePickSource')}
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'off' as const, label: t('settings.knowledgeModeOff') },
                    { id: 'ollama' as const, label: t('settings.knowledgeModeLocal') },
                    { id: 'openai' as const, label: t('settings.knowledgeModeCloud') },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setEmbeddingProvider(opt.id)}
                    className={
                      'rounded-lg border px-1.5 py-2 text-center text-[11px] font-medium leading-tight transition-colors ' +
                      (embeddingProvider === opt.id
                        ? 'border-primary-500/80 bg-primary-500/12 text-primary-800 shadow-sm ring-1 ring-primary-500/15 dark:border-primary-400/55 dark:bg-primary-500/18 dark:text-primary-100 dark:ring-primary-400/10'
                        : 'border-stone-300/40 bg-stone-100/85 text-stone-700 hover:border-stone-400/50 hover:bg-stone-200/60 dark:border-white/12 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:border-white/18 dark:hover:bg-slate-700/70')
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {embeddingProvider === 'off' && (
                <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                  {t('settings.knowledgeHintOff')}
                </p>
              )}
              {embeddingProvider === 'ollama' && (
                <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                  {t('settings.knowledgeHintLocal')}
                </p>
              )}
              {embeddingProvider === 'openai' && (
                <>
                  <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                    {t('settings.knowledgeHintCloud')}
                  </p>
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                      {t('settings.cloudApiKey')}
                    </label>
                    <input
                      type="password"
                      autoComplete="off"
                      value={embeddingApiKey}
                      onChange={(e) => setEmbeddingApiKey(e.target.value)}
                      placeholder="sk-…"
                      className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                    />
                  </div>
                </>
              )}
              <details className="rounded-lg border border-stone-300/38 bg-stone-100/70 px-2 py-1.5 dark:border-white/10 dark:bg-slate-900/55">
                <summary className="cursor-pointer select-none list-none text-[10px] font-medium text-stone-600 dark:text-slate-400 [&::-webkit-details-marker]:hidden">
                  {t('settings.advanced')}
                </summary>
                <div className="mt-2 space-y-2 border-t border-stone-300/35 pt-2 dark:border-white/8">
                  {embeddingProvider !== 'off' && (
                    <>
                      <div>
                        <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                          {t('settings.embedUrl')}
                        </label>
                        <input
                          type="text"
                          value={embeddingApiUrl}
                          onChange={(e) => setEmbeddingApiUrl(e.target.value)}
                          placeholder={
                            embeddingProvider === 'ollama'
                              ? t('settings.embedUrlPhOllama')
                              : t('settings.embedUrlPhOpenAI')
                          }
                          className="w-full rounded-md border border-stone-400/30 bg-stone-100/95 px-2 py-1 font-mono text-[10px] text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500/70 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                        />
                      </div>
                      <div>
                        <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                          {t('settings.embedModel')}
                        </label>
                        <input
                          type="text"
                          value={embeddingModel}
                          onChange={(e) => setEmbeddingModel(e.target.value)}
                          className="w-full rounded-md border border-stone-400/30 bg-stone-100/95 px-2 py-1 font-mono text-[10px] text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500/70 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                        />
                      </div>
                      {embeddingProvider === 'openai' && (
                        <div className="rounded-md border border-stone-300/40 bg-stone-50/90 px-2 py-1.5 dark:border-white/10 dark:bg-slate-800/50">
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 text-[9px] leading-snug text-stone-700 dark:text-slate-300">
                              {t('settings.embedVolcMultimodal')}
                            </span>
                            <IosSwitch
                              checked={embeddingVolcMultimodal}
                              aria-label={t('settings.embedVolcMultimodal')}
                              onChange={setEmbeddingVolcMultimodal}
                            />
                          </div>
                          <p className="mt-1 text-[9px] leading-relaxed text-stone-500 dark:text-slate-500">
                            {t('settings.embedVolcMultimodalHint')}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <div className="min-w-[5rem] flex-1">
                      <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                        {t('settings.ragTopK')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={vectorTopK}
                        onChange={(e) => setVectorTopK(parseInt(e.target.value, 10) || 5)}
                        className="w-full rounded border border-stone-400/30 bg-stone-100/95 px-1.5 py-0.5 text-[10px] text-stone-900 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                      />
                    </div>
                    <div className="min-w-[6rem] flex-[1.2]">
                      <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                        {t('settings.ragMaxInject')}
                      </label>
                      <input
                        type="number"
                        min={1000}
                        max={30000}
                        step={500}
                        value={ragMaxInjectChars}
                        onChange={(e) => setRagMaxInjectChars(parseInt(e.target.value, 10) || 8000)}
                        className="w-full rounded border border-stone-400/30 bg-stone-100/95 px-1.5 py-0.5 text-[10px] text-stone-900 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                      />
                    </div>
                  </div>
                </div>
              </details>
              <p className="text-[10px] text-stone-500 dark:text-slate-500">
                {indexMeta && indexMeta.chunkCount > 0
                  ? t('settings.indexStatus', {
                      chunks: indexMeta.chunkCount,
                      time:
                        indexMeta.updatedAt > 0
                          ? new Date(indexMeta.updatedAt).toLocaleString()
                          : '—',
                    })
                  : t('settings.indexNone')}
              </p>
              <button
                type="button"
                disabled={knowledgeIndexLocked}
                onClick={async () => {
                  const root = rootPath.trim();
                  if (!root) {
                    alert(t('settings.indexRootMissing'));
                    return;
                  }
                  const embed = getEmbedConfigForIpc();
                  if (!embed) {
                    alert(t('settings.indexEmbedOff'));
                    return;
                  }
                  setIndexBusy(true);
                  try {
                    const r = await window.electron.knowledgeIndexWorkspace({ root, embed, mode: 'full' });
                    if (!r.ok) {
                      alert(r.error || 'index failed');
                      return;
                    }
                    if (r.truncated) {
                      alert(t('settings.indexTruncated'));
                    }
                    await refreshIndexStatus();
                  } finally {
                    setIndexBusy(false);
                  }
                }}
                className="w-full rounded-lg bg-primary-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {indexBusy ? t('settings.reindexing') : t('settings.reindex')}
              </button>
              <p className="text-[9px] leading-snug text-stone-500 dark:text-slate-500">
                {t('settings.indexIncrementalHint')}
              </p>
              <button
                type="button"
                disabled={knowledgeIndexLocked}
                onClick={async () => {
                  const root = rootPath.trim();
                  if (!root) {
                    alert(t('settings.indexRootMissing'));
                    return;
                  }
                  const embed = getEmbedConfigForIpc();
                  if (!embed) {
                    alert(t('settings.indexEmbedOff'));
                    return;
                  }
                  setIncrementalIndexBusy(true);
                  try {
                    const r = await window.electron.knowledgeIndexWorkspace({
                      root,
                      embed,
                      mode: 'incremental',
                    });
                    if (!r.ok) {
                      alert(r.error || 'index failed');
                      return;
                    }
                    if (r.truncated) {
                      alert(t('settings.indexTruncated'));
                    }
                    await refreshIndexStatus();
                  } finally {
                    setIncrementalIndexBusy(false);
                  }
                }}
                className="w-full rounded-lg border border-stone-400/38 bg-stone-100/90 px-3 py-2 text-xs font-medium text-stone-800 transition-colors hover:bg-stone-200/95 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-500/40 dark:bg-slate-800/85 dark:text-slate-100 dark:hover:bg-slate-700"
              >
                {incrementalIndexBusy ? t('settings.indexIncrementalBusy') : t('settings.indexIncremental')}
              </button>
            </div>
          )}
        </section>

        <section
          className={`${cardShell} mt-2 shrink-0`}
          aria-labelledby="settings-app-heading"
        >
          <div className="flex items-center justify-between gap-2 border-b border-stone-300/38 px-3 py-2.5 dark:border-white/10">
            <div className="flex min-w-0 items-center gap-2">
              <FiZap className="shrink-0 text-primary-600 dark:text-primary-400" size={16} aria-hidden />
              <h2 id="settings-app-heading" className="text-sm font-semibold text-stone-800 dark:text-white">
                {t('settings.app')}
              </h2>
            </div>
            <button
              type="button"
              aria-expanded={appBlockExpanded}
              onClick={() => setAppBlockExpanded((v) => !v)}
              className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-200/65 dark:hover:bg-white/10"
            >
              {appBlockExpanded ? <FiChevronUp size={18} /> : <FiChevronDown size={18} />}
            </button>
          </div>
          {appBlockExpanded && (
            <div className="space-y-3 px-3 pb-3 pt-3">
              <div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={streamResponses}
                    onChange={(e) => setStreamResponses(e.target.checked)}
                    className="shrink-0 rounded border-stone-400"
                  />
                  <span className="shrink-0 text-xs text-stone-700 dark:text-slate-300 whitespace-nowrap">
                    {t('settings.stream')}
                  </span>
                </label>
                <p className="mt-1.5 pl-6 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                  {t('settings.streamDesc')}
                </p>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-slate-300">
                  <FiFolder size={14} className="text-stone-500" aria-hidden />
                  {t('settings.workspace')}
                </div>
                <p className="mb-1.5 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                  {t('settings.workspaceDesc')}
                </p>
                <input
                  type="text"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                  placeholder={t('settings.workspacePlaceholder')}
                  className="w-full rounded-md border border-stone-400/30 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-[10px] font-medium text-stone-700 dark:text-slate-200">
                    {t('settings.maxChars')}
                  </label>
                  <input
                    type="number"
                    min={500}
                    max={200000}
                    value={maxChars}
                    onChange={(e) => setMaxChars(parseInt(e.target.value, 10) || 12000)}
                    className="w-24 rounded border border-stone-400/30 bg-stone-100/90 px-1.5 py-0.5 text-xs text-stone-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                </div>
              </div>
              <div className="rounded-lg border border-stone-300/50 bg-stone-50/80 p-2.5 dark:border-white/10 dark:bg-slate-800/40">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-stone-800 dark:text-slate-200">
                  <FiShield size={14} className="text-amber-600/90 dark:text-amber-400" aria-hidden />
                  {t('settings.privacy')}
                </div>
                <p className="text-[10px] leading-relaxed text-stone-600 dark:text-slate-500">
                  {t('settings.privacyDesc')}
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(t('settings.clearConfirm'))) {
                      return;
                    }
                    try {
                      if (window.electron?.persistClearAll) {
                        await window.electron.persistClearAll();
                      }
                    } catch {
                      /* ignore */
                    }
                    const keys = [
                      'chat-storage',
                      'setting-storage',
                      'workspace-storage',
                      'web-search-storage',
                      'model-storage',
                      'knowledge-storage',
                      'myagent-onboarding-dismissed',
                    ];
                    keys.forEach((k) => localStorage.removeItem(k));
                    location.reload();
                  }}
                  className="mt-2 w-full rounded-md border border-red-400/40 bg-red-50/90 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100/90 dark:border-red-500/30 dark:bg-red-950/50 dark:text-red-200 dark:hover:bg-red-900/50"
                >
                  {t('settings.clearAll')}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default SettingsPanel;