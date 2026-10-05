/** 应用设置：手势、Agent 权限、工作区、远端网关与隐私。语音及回答设置由模型配置统一管理。 */

import React, { useState, useEffect } from 'react';
import {
  FiZap,
  FiChevronUp,
  FiChevronDown,
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
import { confirmDestructive } from '../../store/confirmStore';

/** 远端网关运行态（原父组件 useState<'unsupported' | 'ready'> 派生） */
export type GatewayStatus = 'unsupported' | 'ready';

/** 远端网关配置（原父组件 useState） */
export interface GatewayConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface AppSectionProps {
  /** 摄像头物理缺失（原父组件 useMediaInputAvailability 派生） */
  cameraMissing: boolean;
  /** 卡片外壳 CSS（父组件常量） */
  cardShell: string;
  /** i18n 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const AppSection: React.FC<AppSectionProps> = ({
  cameraMissing,
  cardShell,
  t,
}) => {
  // 本组件内部状态：折叠态 + 远端网关
  const [appBlockExpanded, setAppBlockExpanded] = useState(false);
  const [gwStatus, setGwStatus] = useState<GatewayStatus>('unsupported');
  const [gwCfg, setGwCfg] = useState<GatewayConfig | null>(null);
  const [showGatewayToken, setShowGatewayToken] = useState(false);
  const [gwPortDraft, setGwPortDraft] = useState('9742');

  // 远端网关配置初始化（原父组件 useEffect，移入本组件）
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
  // store 派生量本组件自己消费
  const {
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

  return (
    <section
      className={`${cardShell} shrink-0`}
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
                placeholder={t('settings.agentDeniedPathsPh')}
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
              placeholder={t('settings.workspacePh')}
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
                    if (!(await confirmDestructive(t('settings.remoteGateway.confirmRegenerate')))) return;
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
                if (!(await confirmDestructive(t('settings.confirmClear')))) {
                  return;
                }
                try {
                  if (window.electron?.persistClearAll) {
                    await window.electron.persistClearAll();
                  }
                } catch (err) {
                  showError('settings.clearFailed', {
                    detail: err instanceof Error ? err.message : String(err),
                  });
                  return;
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
