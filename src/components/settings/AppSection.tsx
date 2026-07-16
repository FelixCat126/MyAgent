/**
 * 应用设置区：流式输出、语音输入/唤醒/语音回复、火山流式 ASR、手势识别、
 * 粒子场、Agent 工具（本地工具 / 拒绝路径 / 浏览器）、工作区、远端网关、隐私清空。
 *
 * 抽离自 SettingsPanel.tsx（aria-labelledby="settings-app-heading" 的 <section>），
 * 行为与拆分前完全一致。
 *
 * 状态拆分原则：
 *  - store 派生量（streamResponses / voiceWakeEnabled / rootPath 等）→ 本组件自己调对应 store hook
 *  - 父组件局部 useState（折叠态 / gwStatus / gwCfg / showGatewayToken / gwPortDraft 等）→ 通过 props 传入
 *  - 硬件探测派生量（microphoneMissing / cameraMissing）与 TTS 可用性（ttsPlaybackReady）→ 由父组件传入
 *    （这些 hook 在父组件挂载以驱动 useEffect 副作用，子组件只读结果即可）
 */

import React from 'react';
import {
  FiZap,
  FiChevronUp,
  FiChevronDown,
  FiActivity,
  FiMic,
  FiCamera,
  FiCpu,
  FiFolder,
  FiSmartphone,
  FiShield,
} from 'react-icons/fi';
import { IosSwitch } from '../IosSwitch';
import { useSettingStore } from '../../store/settingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { PERSIST_KEYS } from '../../utils/persistKeys';
import { isAgentToolsBuildEnabled } from '../../agent/buildFlags';
import { showError, showSuccess, showWarning } from '../../store/errorStore';

/** 远端网关运行态（原父组件 useState<'unsupported' | 'ready'> 派生） */
export type GatewayStatus = 'unsupported' | 'ready';

/** 远端网关配置（原父组件 useState） */
export interface GatewayConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface AppSectionProps {
  /** 折叠态（父组件 useState） */
  appBlockExpanded: boolean;
  setAppBlockExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * 系统级 TTS 可用性（原父组件 useSystemTtsAvailable(locale) 返回值）。
   * 三态：null=检测中；false=不可用；true=可用。
   * - false 时显示「无系统 TTS」警告
   * - true 时才允许开启语音回复（ttsPlaybackReady = systemTtsAvailable === true）
   */
  systemTtsAvailable: boolean | null;
  /** 麦克风物理缺失（原父组件 useMediaInputAvailability 派生） */
  microphoneMissing: boolean;
  /** 摄像头物理缺失（原父组件 useMediaInputAvailability 派生） */
  cameraMissing: boolean;
  /** 当前语言，用于火山 ASR 文档链接（zh/en） */
  locale: string;
  /** 远端网关运行态（父组件 useState） */
  gwStatus: GatewayStatus;
  setGwStatus: React.Dispatch<React.SetStateAction<GatewayStatus>>;
  /** 远端网关配置（父组件 useState：value + setter） */
  gwCfg: GatewayConfig | null;
  setGwCfg: React.Dispatch<React.SetStateAction<GatewayConfig | null>>;
  /** 是否明文展示网关 token（父组件 useState：value + setter） */
  showGatewayToken: boolean;
  setShowGatewayToken: React.Dispatch<React.SetStateAction<boolean>>;
  /** 网关端口草稿（父组件 useState：value + setter） */
  gwPortDraft: string;
  setGwPortDraft: React.Dispatch<React.SetStateAction<string>>;
  /** 卡片外壳 CSS（父组件常量） */
  cardShell: string;
  /** i18n 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const AppSection: React.FC<AppSectionProps> = ({
  appBlockExpanded,
  setAppBlockExpanded,
  systemTtsAvailable,
  microphoneMissing,
  cameraMissing,
  locale,
  gwStatus,
  gwCfg,
  setGwCfg,
  showGatewayToken,
  setShowGatewayToken,
  gwPortDraft,
  setGwPortDraft,
  cardShell,
  t,
}) => {
  // store 派生量本组件自己消费
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

  /** 系统级 TTS 是否已就绪可用于语音回复（原父组件派生量） */
  const ttsPlaybackReady = systemTtsAvailable === true;

  return (
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
                      .catch((err: unknown) =>
                        showError('common.operationFailed', {
                          detail: err instanceof Error ? err.message : String(err),
                        })
                      );
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
                      showWarning('settings.remoteGateway.portInvalid');
                      return;
                    }
                    try {
                      const next = await window.electron.remoteGatewaySetConfig({ port: p });
                      setGwCfg(next);
                      setGwPortDraft(String(next.port));
                      showSuccess('settings.remoteGateway.saved');
                    } catch (err) {
                      showError('settings.remoteGateway.saveFailed', {
                        detail: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                >
                  {t('settings.remoteGateway.applyPort')}
                </button>
              </div>
              <label className="mb-0.5 mt-2 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                {t('settings.remoteGateway.token')}
              </label>
              {(() => {
                const token = gwCfg.token;
                const masked = token.length > 4
                  ? t('settings.remoteGateway.tokenMasked', { last4: token.slice(-4) })
                  : '••••••••';
                return (
                  <textarea
                    readOnly
                    value={showGatewayToken ? token : masked}
                    rows={2}
                    aria-label={t('settings.remoteGateway.token')}
                    className="mb-2 w-full resize-none rounded-md border border-stone-400/25 bg-stone-100/80 px-2 py-1 font-mono text-[11px] text-stone-900 dark:border-gray-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                );
              })()}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-stone-400/35 bg-stone-100/95 px-3 py-2 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:bg-stone-200/90 dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-100 dark:hover:bg-slate-700/95"
                  onClick={() => setShowGatewayToken((v) => !v)}
                >
                  {showGatewayToken
                    ? t('settings.remoteGateway.hideToken')
                    : t('settings.remoteGateway.showToken')}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-stone-400/35 bg-stone-100/95 px-3 py-2 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:bg-stone-200/90 dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-100 dark:hover:bg-slate-700/95"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(gwCfg.token);
                      showSuccess('settings.remoteGateway.copied');
                    } catch {
                      /** 安全：复制失败绝不 alert token */
                      showError('settings.remoteGateway.copyFailed');
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
                      setShowGatewayToken(true);
                    } catch (err) {
                      showError('settings.remoteGateway.regenerateFailed', {
                        detail: err instanceof Error ? err.message : String(err),
                      });
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
                const keys = Object.values(PERSIST_KEYS);
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
  );
};

export default AppSection;
