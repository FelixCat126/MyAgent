import React, { useState, useEffect, useCallback } from 'react';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { ModelConfig } from '../types';
import { WebSearchSection } from './settings/WebSearchSection';
import { KnowledgeSection } from './settings/KnowledgeSection';
import { AppSection } from './settings/AppSection';
import { ModelsSection } from './settings/ModelsSection';
import { useI18n } from '../hooks/useI18n';
import { showError, showWarning } from '../store/errorStore';
import { useSystemTtsAvailable } from '@/hooks/useSystemTtsAvailable';
import { useMediaInputAvailability } from '@/hooks/useMediaInputAvailability';
import {
  resolveImageProviderId,
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
  const { models, addModel, updateModel } = useModelStore();
  const {
    enabled: webSearchEnabled,
    provider: webSearchProvider,
    apiKey: webSearchApiKey,
    setEnabled: setWebSearchEnabled,
    setProvider: setWebSearchProvider,
    setApiKey: setWebSearchApiKey,
  } = useWebSearchStore();
  const {
    speechInputEnabled,
    setSpeechInputEnabled,
    voiceWakeEnabled,
    setVoiceWakeEnabled,
    voiceReplyEnabled,
    setVoiceReplyEnabled,
    gestureControlEnabled,
    setGestureControlEnabled,
  } = useSettingStore();
  const [modelBlockExpanded, setModelBlockExpanded] = useState(false);
  const [webSearchBlockExpanded, setWebSearchBlockExpanded] = useState(false);
  const [knowledgeBlockExpanded, setKnowledgeBlockExpanded] = useState(false);
  const [appBlockExpanded, setAppBlockExpanded] = useState(false);
  const [gwStatus, setGwStatus] = useState<'unsupported' | 'ready'>('unsupported');
  const [gwCfg, setGwCfg] = useState<{ enabled: boolean; port: number; token: string } | null>(null);
  const [showGatewayToken, setShowGatewayToken] = useState(false);
  const [gwPortDraft, setGwPortDraft] = useState('9742');
  const [indexBusy, setIndexBusy] = useState(false);
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
        <ModelsSection
          modelBlockExpanded={modelBlockExpanded}
          setModelBlockExpanded={setModelBlockExpanded}
          showForm={showForm}
          setShowForm={setShowForm}
          editingId={editingId}
          setEditingId={setEditingId}
          formData={formData}
          setFormData={setFormData}
          startAdd={startAdd}
          startEdit={startEdit}
          handleSave={handleSave}
          cardShell={cardShell}
          t={t}
        />

        <WebSearchSection
          webSearchBlockExpanded={webSearchBlockExpanded}
          setWebSearchBlockExpanded={setWebSearchBlockExpanded}
          webSearchEnabled={webSearchEnabled}
          setWebSearchEnabled={setWebSearchEnabled}
          webSearchProvider={webSearchProvider}
          setWebSearchProvider={setWebSearchProvider}
          webSearchApiKey={webSearchApiKey}
          setWebSearchApiKey={setWebSearchApiKey}
          cardShell={cardShell}
          t={t}
        />

        <KnowledgeSection
          knowledgeBlockExpanded={knowledgeBlockExpanded}
          setKnowledgeBlockExpanded={setKnowledgeBlockExpanded}
          indexBusy={indexBusy}
          setIndexBusy={setIndexBusy}
          indexMeta={indexMeta}
          refreshIndexStatus={refreshIndexStatus}
          cardShell={cardShell}
          t={t}
        />

        <AppSection
          appBlockExpanded={appBlockExpanded}
          setAppBlockExpanded={setAppBlockExpanded}
          systemTtsAvailable={systemTtsAvailable}
          microphoneMissing={microphoneMissing}
          cameraMissing={cameraMissing}
          locale={locale}
          gwStatus={gwStatus}
          setGwStatus={setGwStatus}
          gwCfg={gwCfg}
          setGwCfg={setGwCfg}
          showGatewayToken={showGatewayToken}
          setShowGatewayToken={setShowGatewayToken}
          gwPortDraft={gwPortDraft}
          setGwPortDraft={setGwPortDraft}
          cardShell={cardShell}
          t={t}
        />

      </div>
    </div>
  );
};

export default SettingsPanel;
