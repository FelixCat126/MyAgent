import React, { useState, useEffect, useCallback } from 'react';
import { useModelStore, modelHasUsableImageGenerator } from '../store/modelStore';
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
  FiChevronRight,
  FiGlobe,
  FiCpu,
  FiActivity,
  FiZap,
  FiFolder,
  FiShield,
  FiLayers,
  FiMic,
  FiCamera,
  FiSmartphone,
} from 'react-icons/fi';
import { IosSwitch } from './IosSwitch';
import { useI18n } from '../hooks/useI18n';
import { useSystemTtsAvailable } from '@/hooks/useSystemTtsAvailable';
import { useMediaInputAvailability } from '@/hooks/useMediaInputAvailability';
import { isAgentToolsBuildEnabled } from '@/agent/buildFlags';
import {
  IMAGE_PROVIDER_PRESETS,
  getImageProviderPreset,
  getPresetDefaults,
  imageGenNeedsApiKey,
  inferImageProviderFromEndpoint,
  resolveImageProviderId,
  suggestedHttpFormatForProvider,
  type ImageProviderId,
} from '../utils/imageProviderPresets';

type EditingFormData = {
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

const defaultFormData: EditingFormData = {
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

const SettingsPanel: React.FC = () => {
  const { t, locale } = useI18n();
  const systemTtsAvailable = useSystemTtsAvailable(locale);
  const ttsPlaybackReady = systemTtsAvailable === true;
  const { models, addModel, removeModel, updateModel, imageGenModelId, setImageGenModel } = useModelStore();
  const {
    enabled: webSearchEnabled,
    provider: webSearchProvider,
    apiKey: webSearchApiKey,
    setEnabled: setWebSearchEnabled,
    setProvider: setWebSearchProvider,
    setApiKey: setWebSearchApiKey,
  } = useWebSearchStore();
  const {
    streamResponses,
    setStreamResponses,
    speechInputEnabled,
    setSpeechInputEnabled,
    voiceWakeEnabled,
    setVoiceWakeEnabled,
    voiceWakePhrase,
    setVoiceWakePhrase,
    voiceReplyEnabled,
    setVoiceReplyEnabled,
    volcAsrAppKey,
    setVolcAsrAppKey,
    volcAsrAccessKey,
    setVolcAsrAccessKey,
    volcAsrResourceId,
    setVolcAsrResourceId,
    gestureControlEnabled,
    setGestureControlEnabled,
    particleFieldEnabled,
    setParticleFieldEnabled,
    agentLocalToolsEnabled,
    setAgentLocalToolsEnabled,
    agentBrowserEnabled,
    setAgentBrowserEnabled,
    agentDeniedPaths,
    setAgentDeniedPaths,
  } = useSettingStore();
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
  const [modelBlockExpanded, setModelBlockExpanded] = useState(false);
  const [webSearchBlockExpanded, setWebSearchBlockExpanded] = useState(false);
  const [knowledgeBlockExpanded, setKnowledgeBlockExpanded] = useState(false);
  const [appBlockExpanded, setAppBlockExpanded] = useState(false);
  const [gwStatus, setGwStatus] = useState<'unsupported' | 'ready'>('unsupported');
  const [gwCfg, setGwCfg] = useState<{ enabled: boolean; port: number; token: string } | null>(null);
  const [gwPortDraft, setGwPortDraft] = useState('9742');
  const [indexBusy, setIndexBusy] = useState(false);
  const knowledgeIndexLocked = indexBusy;
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

  useEffect(() => {
    if (systemTtsAvailable === false && voiceReplyEnabled) {
      setVoiceReplyEnabled(false);
    }
  }, [systemTtsAvailable, voiceReplyEnabled, setVoiceReplyEnabled]);

  /**
   * 硬件可用性检测：物理缺失则强制关闭对应开关，避免在无硬件环境下被意外激活。
   * - 摄像头缺失 → 手势/视觉识别关闭并禁用
   * - 麦克风缺失 → 语音输入 / 唤醒 / 播报三者全部关闭并禁用
   */
  const mediaAvail = useMediaInputAvailability();
  const cameraMissing = mediaAvail.camera === 'missing';
  const microphoneMissing = mediaAvail.microphone === 'missing';

  useEffect(() => {
    if (cameraMissing && gestureControlEnabled) setGestureControlEnabled(false);
  }, [cameraMissing, gestureControlEnabled, setGestureControlEnabled]);

  useEffect(() => {
    if (!microphoneMissing) return;
    if (speechInputEnabled) setSpeechInputEnabled(false);
    if (voiceWakeEnabled) setVoiceWakeEnabled(false);
    if (voiceReplyEnabled) setVoiceReplyEnabled(false);
  }, [
    microphoneMissing,
    speechInputEnabled,
    setSpeechInputEnabled,
    voiceWakeEnabled,
    setVoiceWakeEnabled,
    voiceReplyEnabled,
    setVoiceReplyEnabled,
  ]);

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
  };

  const handleSave = () => {
    if (!formData.name || !formData.apiUrl || !formData.modelName) {
      alert(t('settings.form.required'));
      return;
    }

    const envMap = parseEnvMap(formData.imageGenEnv);
    const imageGenError = validateImageGeneratorForm(formData, envMap);
    if (imageGenError) {
      alert(imageGenError);
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
  };

  useEffect(() => {
    try {
      const e = window.electron;
      if (!e?.remoteGatewayGetConfig) {
        setGwStatus('unsupported');
        return;
      }
      void e
        .remoteGatewayGetConfig()
        .then((c) => {
          setGwCfg(c);
          setGwPortDraft(String(c.port));
          setGwStatus('ready');
        })
        .catch(() => setGwStatus('unsupported'));
    } catch {
      setGwStatus('unsupported');
    }
  }, []);

  const cardShell =
    'mx-3 rounded-xl border border-stone-300/45 bg-white/88 shadow-sm dark:border-white/10 dark:bg-slate-900/55 dark:shadow-none';

  return (
    <div className="flex h-full flex-col bg-stone-100/95 backdrop-blur-xl dark:bg-[#0B1120]/80">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2.5 scrollbar-hide" data-gesture-scroll-target="settings">
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
              <details className="group/details rounded-lg border border-stone-300/38 bg-stone-100/70 px-2 py-1.5 dark:border-white/10 dark:bg-slate-900/55">
                <summary className="flex cursor-pointer items-center gap-1 select-none text-[10px] font-medium text-stone-600 dark:text-slate-400 list-none [&::-webkit-details-marker]:hidden">
                  <FiChevronRight
                    size={12}
                    className="shrink-0 text-stone-400 transition-transform duration-200 group-open/details:rotate-90 dark:text-slate-500"
                    aria-hidden
                  />
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
                    const r = await window.electron.knowledgeIndexWorkspace({ root, embed });
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
                <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-slate-300">
                  <FiActivity size={14} className="text-stone-500" aria-hidden />
                  {t('settings.streaming.sectionTitle')}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-stone-700 dark:text-slate-300">{t('settings.stream')}</span>
                  <IosSwitch
                    checked={streamResponses}
                    aria-label={t('settings.stream')}
                    onChange={setStreamResponses}
                  />
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                  {t('settings.streamDesc')}
                </p>
              </div>
              <div className="border-t border-stone-300/35 pt-3 dark:border-white/8">
                <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-slate-300">
                  <FiMic size={14} className="text-stone-500" aria-hidden />
                  {t('settings.speech.sectionTitle')}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`text-xs ${microphoneMissing ? 'text-stone-400 dark:text-slate-500' : 'text-stone-700 dark:text-slate-300'}`}
                  >
                    {t('settings.speech.enableMicUi')}
                  </span>
                  <IosSwitch
                    checked={!microphoneMissing && speechInputEnabled}
                    disabled={microphoneMissing}
                    aria-label={t('settings.speech.enableMicUi')}
                    onChange={setSpeechInputEnabled}
                  />
                </div>
                {microphoneMissing ? (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
                    {t('settings.speech.noMicrophone')}
                  </p>
                ) : null}
                {speechInputEnabled ? (
                  <div className="mt-2 space-y-2">
                    {systemTtsAvailable === false ? (
                      <p className="text-[10px] leading-snug text-amber-800/90 dark:text-amber-200/90">
                        {t('settings.speech.noSystemTts')}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-stone-700 dark:text-slate-300">
                        {t('settings.speech.enableWake')}
                      </span>
                      <IosSwitch
                        checked={voiceWakeEnabled}
                        aria-label={t('settings.speech.enableWake')}
                        onChange={setVoiceWakeEnabled}
                      />
                    </div>
                    {voiceWakeEnabled ? (
                      <div>
                        <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                          {t('settings.speech.wakePhrase')}
                        </label>
                        <input
                          type="text"
                          autoComplete="off"
                          value={voiceWakePhrase}
                          onChange={(e) => setVoiceWakePhrase(e.target.value)}
                          onBlur={(e) => setVoiceWakePhrase(e.target.value.trim())}
                          placeholder={t('settings.speech.wakePhrasePlaceholder')}
                          className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                        />
                        <p className="mt-1 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                          {t('settings.speech.wakeDesc', {
                            phrase: voiceWakePhrase.trim() || t('settings.speech.wakePhrasePlaceholder'),
                          })}
                        </p>
                      </div>
                    ) : null}
                    {voiceWakeEnabled ? (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span
                            className={`text-xs ${ttsPlaybackReady ? 'text-stone-700 dark:text-slate-300' : 'text-stone-400 dark:text-slate-500'}`}
                          >
                            {t('settings.speech.voiceReply')}
                          </span>
                          <p
                            className={`mt-0.5 text-[10px] leading-relaxed ${ttsPlaybackReady ? 'text-stone-500 dark:text-slate-500' : 'text-stone-400 dark:text-slate-600'}`}
                          >
                            {t('settings.speech.voiceReplyDesc')}
                          </p>
                        </div>
                        <IosSwitch
                          checked={ttsPlaybackReady && voiceReplyEnabled}
                          aria-label={t('settings.speech.voiceReply')}
                          disabled={!ttsPlaybackReady}
                          onChange={setVoiceReplyEnabled}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {speechInputEnabled && (
                  <div className="mt-2 space-y-2" data-section="volc-asr-keys">
                    <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                      {t('settings.streamingAsr.volcOnly')}{' '}
                      <a
                        className="text-primary-600 underline dark:text-primary-400"
                        href={
                          locale === 'en'
                            ? 'https://www.volcengine.com/docs/6561/1354869?lang=en'
                            : 'https://www.volcengine.com/docs/6561/1354869?lang=zh'
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('settings.streamingAsr.docVolcExample')}
                      </a>
                    </p>
                    <div className="space-y-2">
                      <div>
                        <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                          {t('settings.streamingAsr.fieldAppKey')}
                        </label>
                        <input
                          type="password"
                          autoComplete="off"
                          value={volcAsrAppKey}
                          onChange={(e) => setVolcAsrAppKey(e.target.value)}
                          className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                          {t('settings.streamingAsr.fieldAccess')}
                        </label>
                        <input
                          type="password"
                          autoComplete="off"
                          value={volcAsrAccessKey}
                          onChange={(e) => setVolcAsrAccessKey(e.target.value)}
                          className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                          {t('settings.streamingAsr.fieldResource')}
                        </label>
                        <input
                          type="text"
                          autoComplete="off"
                          value={volcAsrResourceId}
                          onChange={(e) => setVolcAsrResourceId(e.target.value)}
                          className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="border-t border-stone-300/35 pt-3 dark:border-white/8">
                <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-slate-300">
                  <FiCamera size={14} className="text-stone-500" aria-hidden />
                  {t('settings.gesture.sectionTitle')}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`text-xs ${cameraMissing ? 'text-stone-400 dark:text-slate-500' : 'text-stone-700 dark:text-slate-300'}`}
                  >
                    {t('settings.gesture.enable')}
                  </span>
                  <IosSwitch
                    checked={!cameraMissing && gestureControlEnabled}
                    disabled={cameraMissing}
                    aria-label={t('settings.gesture.enable')}
                    onChange={setGestureControlEnabled}
                  />
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                  {t('settings.gesture.desc')}
                </p>
                {cameraMissing ? (
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
                    {t('settings.gesture.noCamera')}
                  </p>
                ) : null}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-stone-700 dark:text-slate-300">
                    {t('settings.gesture.particleField')}
                  </span>
                  <IosSwitch
                    checked={particleFieldEnabled}
                    aria-label={t('settings.gesture.particleField')}
                    onChange={setParticleFieldEnabled}
                  />
                </div>
              </div>
              {isAgentToolsBuildEnabled() && (
                <div className="border-t border-stone-300/35 pt-3 dark:border-white/8">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-slate-300">
                    <FiCpu size={14} className="text-stone-500" aria-hidden />
                    {t('settings.agentTools')}
                  </div>
                  <p className="mb-2 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                    {t('settings.agentToolsDesc')}
                  </p>
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="text-xs text-stone-700 dark:text-slate-300">
                      {t('settings.agentLocalTools')}
                    </span>
                    <IosSwitch
                      checked={agentLocalToolsEnabled}
                      aria-label={t('settings.agentLocalTools')}
                      onChange={setAgentLocalToolsEnabled}
                    />
                  </div>
                  <label className="mb-0.5 mt-2 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                    {t('settings.agentDeniedPaths')}
                  </label>
                  <p className="mb-1 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                    {t('settings.agentDeniedPathsDesc')}
                  </p>
                  <textarea
                    value={agentDeniedPaths.join('\n')}
                    onChange={(e) =>
                      setAgentDeniedPaths(
                        e.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean)
                      )
                    }
                    placeholder={t('settings.agentDeniedPathsPlaceholder')}
                    rows={3}
                    className="w-full resize-y rounded-md border border-stone-400/30 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="text-xs text-stone-700 dark:text-slate-300">
                      {t('settings.agentBrowser')}
                    </span>
                    <IosSwitch
                      checked={agentBrowserEnabled}
                      aria-label={t('settings.agentBrowser')}
                      onChange={setAgentBrowserEnabled}
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-stone-400 dark:text-slate-600">
                    {t('settings.agentBrowserDesc')}
                  </p>
                </div>
              )}
              <div className="border-t border-stone-300/35 pt-3 dark:border-white/8">
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
              {gwStatus === 'ready' && gwCfg && (
                <div className="border-t border-stone-300/35 pt-3 dark:border-white/8">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-slate-300">
                    <FiSmartphone size={14} className="text-stone-500" aria-hidden />
                    {t('settings.remoteGateway.title')}
                  </div>
                  <p className="mb-2 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                    {t('settings.remoteGateway.desc')}
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-stone-700 dark:text-slate-300">
                      {t('settings.remoteGateway.enable')}
                    </span>
                    <IosSwitch
                      checked={gwCfg.enabled}
                      aria-label={t('settings.remoteGateway.enable')}
                      onChange={(on) => {
                        void window.electron
                          .remoteGatewaySetConfig({ enabled: on })
                          .then((next) => {
                            setGwCfg(next);
                            setGwPortDraft(String(next.port));
                          })
                          .catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)));
                      }}
                    />
                  </div>
                  <label className="mb-0.5 mt-3 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                    {t('settings.remoteGateway.port')}
                  </label>
                  <div className="mt-2 flex flex-wrap items-stretch gap-2">
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={gwPortDraft}
                      onChange={(e) => setGwPortDraft(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-stone-400/30 bg-stone-100/95 px-2.5 py-2 font-mono text-xs text-stone-900 shadow-sm dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-100"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-lg bg-primary-600 px-3 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
                      onClick={async () => {
                        const p = parseInt(gwPortDraft, 10);
                        if (!Number.isFinite(p) || p < 1024 || p > 65535) {
                          alert(t('settings.remoteGateway.portInvalid'));
                          return;
                        }
                        try {
                          const next = await window.electron.remoteGatewaySetConfig({ port: p });
                          setGwCfg(next);
                          setGwPortDraft(String(next.port));
                          alert(t('settings.remoteGateway.saved'));
                        } catch (err) {
                          alert(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      {t('settings.remoteGateway.applyPort')}
                    </button>
                  </div>
                  <label className="mb-0.5 mt-2 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                    {t('settings.remoteGateway.token')}
                  </label>
                  <textarea
                    readOnly
                    value={gwCfg.token}
                    rows={2}
                    className="mb-2 w-full resize-none rounded-md border border-stone-400/25 bg-stone-100/80 px-2 py-1 font-mono text-[11px] text-stone-900 dark:border-gray-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-stone-400/35 bg-stone-100/95 px-3 py-2 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:bg-stone-200/90 dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-100 dark:hover:bg-slate-700/95"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(gwCfg.token);
                          alert(t('settings.remoteGateway.saved'));
                        } catch {
                          alert(gwCfg.token);
                        }
                      }}
                    >
                      {t('settings.remoteGateway.copy')}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-stone-400/35 bg-stone-100/95 px-3 py-2 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:bg-stone-200/90 dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-100 dark:hover:bg-slate-700/95"
                      onClick={async () => {
                        if (!confirm(t('settings.remoteGateway.confirmRegenerate'))) return;
                        try {
                          const next = await window.electron.remoteGatewaySetConfig({ regenerateToken: true });
                          setGwCfg(next);
                        } catch (err) {
                          alert(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      {t('settings.remoteGateway.regenerate')}
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                    {t('settings.remoteGateway.hint')}
                  </p>
                </div>
              )}
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
