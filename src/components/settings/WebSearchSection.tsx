/**
 * 联网搜索设置区：provider 切换（duckduckgo / Tavily / Brave）、API Key 输入。
 *
 * 抽离自 SettingsPanel.tsx（行 991-1057），行为与拆分前完全一致。
 *
 * 状态拆分原则：
 *  - store 派生量（enabled / provider / apiKey）→ 本组件自己调 useWebSearchStore
 *  - 折叠态（webSearchBlockExpanded）→ 本组件内部 useState
 */

import React, { useState } from 'react';
import { FiGlobe, FiChevronUp, FiChevronDown } from 'react-icons/fi';
import { IosSwitch } from '../IosSwitch';
import { useWebSearchStore } from '../../store/webSearchStore';
import type { WebSearchProvider } from '../../types';

export interface WebSearchSectionProps {
  /** 卡片外壳 CSS（父组件常量） */
  cardShell: string;
  /** i18n 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const WebSearchSection: React.FC<WebSearchSectionProps> = ({ cardShell, t }) => {
  // store 派生量本组件自己消费
  const {
    enabled: webSearchEnabled,
    provider: webSearchProvider,
    apiKey: webSearchApiKey,
    setEnabled: setWebSearchEnabled,
    setProvider: setWebSearchProvider,
    setApiKey: setWebSearchApiKey,
  } = useWebSearchStore();

  // 本组件内部状态：折叠态
  const [webSearchBlockExpanded, setWebSearchBlockExpanded] = useState(false);

  return (
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
              <option value="duckduckgo">{t('settings.duckDuckGo.option')}</option>
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
  );
};

export default WebSearchSection;
